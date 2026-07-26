#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@vaz/schemas/deps";
import { Pool, type PoolClient } from "pg";

/**
 * `@vaz/db` migrate CLI (R2.3) — `mise run db:migrate` /
 * `pnpm --filter @vaz/db run migrate`.
 *
 * The composition root for DDL application: it owns the `pg` Pool (mirrors
 * `packages/rag/bin/ingest.ts`'s composition-root style — `pg` stays a
 * `devDependency` here, matching the intent that `@vaz/db`'s `src/**` stays
 * pg-free, R2.2/004 R2.2). Applies every `packages/db/drizzle/*.sql` file not
 * yet recorded in the `_vaz_migration` tracking table, in lexical filename
 * order, one file per transaction.
 *
 * `_vaz_migration` is what makes re-running this idempotent — but only for a
 * fresh database or one already tracked by it. A database provisioned by
 * hand (manual `psql`, no `_vaz_migration` table) fails loudly instead of
 * silently skipping ahead (ADR-0002) — silently skipping would hide drift
 * between what the DB actually has and what the migration files declare.
 *
 * `main()` runs only when this file is the process entry (`import.meta.main`),
 * so tests can import the pure helpers without opening a database connection.
 */

const TRACKING_TABLE = "_vaz_migration";
/**
 * Postgres SQLSTATE codes for the "this object already exists" collisions the
 * baseline DDL can hit on a pre-existing, untracked database. `0000_baseline.sql`
 * emits `CREATE TYPE` (enums) BEFORE any `CREATE TABLE`, so on such a database
 * the first collision is `duplicate_object` (42710) from the enum, not
 * `duplicate_table` (42P07) — both must map to the fail-loud guidance (ADR-0002),
 * or the enum-first path would surface a raw driver error instead.
 */
const POSTGRES_ALREADY_EXISTS_CODES = new Set([
	"42P07", // duplicate_table (also indexes, sequences — relations)
	"42710", // duplicate_object (types/enums, constraints)
]);
/**
 * Arbitrary fixed key for the session-level advisory lock {@link
 * acquireAdvisoryLock} polls for and holds for the whole `applyMigrations`
 * run (adversarial-review fix, 005). Without it, two concurrent `db:migrate`
 * invocations against the same fresh database can both reach `CREATE
 * TYPE`/`CREATE TABLE`, race, and have the loser's `42710`/`42P07`
 * misdiagnosed as ADR-0002's hand-provisioned-database case rather than as
 * the ordinary concurrency race it actually is. Value has no meaning beyond
 * being stable and specific to this tool (`applyMigrations` is the only
 * caller).
 */
const ADVISORY_LOCK_KEY = 4_820_231_005;
/** Poll interval used by {@link acquireAdvisoryLock} while waiting. */
const LOCK_RETRY_INTERVAL_MS = 2_000;
/**
 * Max total time {@link acquireAdvisoryLock} waits before failing loud
 * (adversarial-review fix, 005) — a blocking `pg_advisory_lock` call would
 * instead hang forever behind a wedged holder (e.g. a crashed process whose
 * connection never closed), with no diagnostic for the operator.
 */
const LOCK_WAIT_TIMEOUT_MS = 30_000;

/** Lists `packages/db/drizzle/*.sql` filenames in lexical (= apply) order. */
export function listMigrationFiles(drizzleDir: string): string[] {
	return readdirSync(drizzleDir)
		.filter((name) => name.endsWith(".sql"))
		.sort();
}

/** The subset of `files` not present in `applied`, preserving `files`' order. */
export function pendingMigrations(files: string[], applied: string[]): string[] {
	const appliedSet = new Set(applied);
	return files.filter((file) => !appliedSet.has(file));
}

/**
 * Resolve the PostgreSQL connection string from the environment (fail-fast).
 * Intentionally not `@vaz/schemas/infra-env`'s shared `parseInfraEnv` (R3.2's
 * single schema): same dep-graph-leaf constraint as {@link createConsoleLogger}
 * below — `@vaz/db` must not carry a runtime import of `@vaz/schemas` either,
 * so this duplicates the fail-fast check locally. Out of Task 3's boundary for
 * this reason — recorded in specs/005-baseline-recovery-refactor.
 */
export function resolveDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
	const url = env.DATABASE_URL?.trim();
	if (!url) {
		throw new Error(
			"DATABASE_URL is required to migrate (e.g. postgres://vaz:vaz@localhost:5432/vaz)",
		);
	}
	return url;
}

/**
 * A minimal console-backed {@link Logger} for the CLI. Intentionally not the
 * shared `@vaz/config#createConsoleLogger` (R3.1's single implementation):
 * `@vaz/db` is a dep-graph leaf and must not import `@vaz/config`, a
 * consumer-side layer (see AGENTS.md's one-way dep graph). Out of Task 3's
 * boundary for this reason — recorded in specs/005-baseline-recovery-refactor.
 */
export function createConsoleLogger(): Logger {
	return {
		debug: (message, fields) => console.debug(message, fields ?? ""),
		info: (message, fields) => console.info(message, fields ?? ""),
		warn: (message, fields) => console.warn(message, fields ?? ""),
		error: (message, fields) => console.error(message, fields ?? ""),
	};
}

/**
 * True when `error` is a Postgres "already exists" collision (duplicate table
 * OR duplicate object/type) — the signal, on a database with no `_vaz_migration`
 * table, that it was provisioned outside db:migrate (ADR-0002 fail-loud).
 */
export function isAlreadyExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string" &&
		POSTGRES_ALREADY_EXISTS_CODES.has((error as { code: string }).code)
	);
}

/**
 * The fail-loud message for a pre-existing, untracked database (ADR-0002):
 * a migration file's `CREATE TABLE`/`CREATE TYPE` collided with something
 * that already exists, and no `_vaz_migration` row explains why. Deliberately
 * does NOT say "no tracking table exists" (adversarial-review fix, 005):
 * `applyMigrations` runs `CREATE TABLE IF NOT EXISTS "_vaz_migration"`
 * unconditionally before ever reaching this branch, so by the time this
 * message can fire the table already exists (empty, or missing only this
 * file's row) — claiming otherwise would be false on every occurrence,
 * including the very first.
 */
export function describeUntrackedExistingDatabase(migrationFile: string): string {
	return (
		`db:migrate failed applying "${migrationFile}": it tried to create something that ` +
		`already exists, but "${TRACKING_TABLE}" has no row recording it as previously applied ` +
		"via db:migrate. This looks like a database provisioned by hand (e.g. manual psql) " +
		"before db:migrate existed. db:migrate refuses to silently skip ahead — either (a) mark " +
		`the already-applied files as applied by inserting their names into "${TRACKING_TABLE}", ` +
		"or (b) drop and recreate the database and re-run mise run db:migrate from a fresh state. " +
		"See docs/adr/0002-ddl-migration-strategy.md."
	);
}

/**
 * Polls `pg_try_advisory_lock` (never a blocking `pg_advisory_lock` call —
 * see {@link LOCK_WAIT_TIMEOUT_MS}) until `client` holds {@link
 * ADVISORY_LOCK_KEY} or {@link LOCK_WAIT_TIMEOUT_MS} elapses, logging once
 * (not on every poll) while waiting. `deps.sleep` is a test seam; production
 * callers get a real `setTimeout`-backed wait.
 */
export async function acquireAdvisoryLock(
	client: PoolClient,
	logger: Logger,
	deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	let waitedMs = 0;
	let warned = false;
	while (true) {
		const { rows } = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS acquired",
			[ADVISORY_LOCK_KEY],
		);
		if (rows[0]?.acquired) return;
		if (!warned) {
			logger.info("db:migrate: waiting for another db:migrate run to release the advisory lock...");
			warned = true;
		}
		if (waitedMs >= LOCK_WAIT_TIMEOUT_MS) {
			throw new Error(
				`db:migrate: timed out after ${LOCK_WAIT_TIMEOUT_MS}ms waiting for the advisory lock ` +
					"held by another db:migrate run. If no other run is actually in progress, check for " +
					"a crashed process still holding an open connection to this database.",
			);
		}
		await sleep(LOCK_RETRY_INTERVAL_MS);
		waitedMs += LOCK_RETRY_INTERVAL_MS;
	}
}

/**
 * Best-effort advisory-unlock: swallows and logs any failure instead of
 * throwing, so a broken connection during cleanup can never override the
 * real error already propagating from the try block above it
 * (adversarial-review fix, 005).
 */
async function releaseAdvisoryLockQuietly(client: PoolClient, logger: Logger): Promise<void> {
	try {
		await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
	} catch (error) {
		logger.warn("db:migrate: failed to release advisory lock during cleanup", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Same rationale as {@link releaseAdvisoryLockQuietly}, for `client.release()`. */
function releaseClientQuietly(client: PoolClient, logger: Logger): void {
	try {
		client.release();
	} catch (error) {
		logger.warn("db:migrate: failed to release database client during cleanup", {
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Applies every pending migration file under `drizzleDir` to `pool`, one
 * transaction per file, recording each in `_vaz_migration` on success.
 *
 * The whole run happens on a single checked-out client, guarded by {@link
 * acquireAdvisoryLock} (adversarial-review fix, 005): concurrent `db:migrate`
 * invocations serialize instead of racing on `CREATE TYPE`/`CREATE TABLE`,
 * which would otherwise risk the loser misdiagnosing an ordinary race as
 * ADR-0002's hand-provisioned-database case. Cleanup (unlock, then release)
 * is best-effort — see {@link releaseAdvisoryLockQuietly} — so a cleanup
 * failure can never mask the real error from the try block above it.
 */
export async function applyMigrations(
	pool: Pool,
	drizzleDir: string,
	logger: Logger,
): Promise<void> {
	const client = await pool.connect();
	try {
		await acquireAdvisoryLock(client, logger);
		try {
			await client.query(
				`CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
					"name" text PRIMARY KEY,
					"applied_at" timestamptz NOT NULL DEFAULT now()
				)`,
			);
			const files = listMigrationFiles(drizzleDir);
			const { rows } = await client.query<{ name: string }>(
				`SELECT "name" FROM "${TRACKING_TABLE}"`,
			);
			const pending = pendingMigrations(
				files,
				rows.map((row) => row.name),
			);

			if (pending.length === 0) {
				logger.info("db:migrate: no pending migrations (already up to date)");
				return;
			}

			for (const file of pending) {
				const sql = readFileSync(join(drizzleDir, file), "utf8");
				try {
					await client.query("BEGIN");
					await client.query(sql);
					await client.query(`INSERT INTO "${TRACKING_TABLE}" ("name") VALUES ($1)`, [file]);
					await client.query("COMMIT");
					logger.info(`db:migrate: applied ${file}`);
				} catch (error) {
					await client.query("ROLLBACK");
					throw isAlreadyExistsError(error)
						? new Error(describeUntrackedExistingDatabase(file))
						: error;
				}
			}
		} finally {
			await releaseAdvisoryLockQuietly(client, logger);
		}
	} finally {
		releaseClientQuietly(client, logger);
	}
}

/** CLI entry: apply every pending `packages/db/drizzle/*.sql` file (R2.3). */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
	const databaseUrl = resolveDatabaseUrl(env);
	const logger = createConsoleLogger();
	const drizzleDir = join(import.meta.dirname, "..", "drizzle");

	const pool = new Pool({ connectionString: databaseUrl });
	try {
		await applyMigrations(pool, drizzleDir, logger);
	} finally {
		await pool.end();
	}
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
