#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@vaz/schemas/deps";
import { Pool } from "pg";

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
 * that already exists, and no `_vaz_migration` row explains why.
 */
export function describeUntrackedExistingDatabase(migrationFile: string): string {
	return (
		`db:migrate failed applying "${migrationFile}": it tried to create something that ` +
		`already exists, but this database has no "${TRACKING_TABLE}" tracking table recording ` +
		"prior applications. This looks like a database provisioned by hand (e.g. manual psql) " +
		"before db:migrate existed. db:migrate refuses to silently skip ahead — either (a) mark " +
		`the already-applied files as applied by inserting their names into "${TRACKING_TABLE}", ` +
		"or (b) drop and recreate the database and re-run mise run db:migrate from a fresh state. " +
		"See docs/adr/0002-ddl-migration-strategy.md."
	);
}

/**
 * Applies every pending migration file under `drizzleDir` to `pool`, one
 * transaction per file, recording each in `_vaz_migration` on success.
 */
export async function applyMigrations(
	pool: Pool,
	drizzleDir: string,
	logger: Logger,
): Promise<void> {
	await pool.query(
		`CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
			"name" text PRIMARY KEY,
			"applied_at" timestamptz NOT NULL DEFAULT now()
		)`,
	);
	const files = listMigrationFiles(drizzleDir);
	const { rows } = await pool.query<{ name: string }>(`SELECT "name" FROM "${TRACKING_TABLE}"`);
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
		const client = await pool.connect();
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
		} finally {
			client.release();
		}
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
