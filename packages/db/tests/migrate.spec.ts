import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
	acquireAdvisoryLock,
	applyMigrations,
	createConsoleLogger,
	describeUntrackedExistingDatabase,
	isAlreadyExistsError,
	listMigrationFiles,
	pendingMigrations,
	resolveDatabaseUrl,
} from "../bin/migrate";

/**
 * `db:migrate` CLI logic (R2.3). File enumeration/ordering, the unapplied-file
 * diff, env parsing, and the untracked-existing-DB message are unit-tested
 * without opening a database connection. `applyMigrations`'s SQL-execution
 * behavior (advisory lock, transaction-per-file, error-code dispatch) is also
 * unit-tested below against a duck-typed mock `Pool`/client — real Postgres
 * SQL syntax/DDL correctness stays verified against a reachable PostgreSQL
 * (see `packages/db/tests/schema-ddl.spec.ts`'s sibling DB-required
 * verification in tasks.md 2.10; adversarial-review fix, 005). Importing this
 * module must NOT run `main()` — the entry is guarded by `import.meta.main`.
 */

describe("listMigrationFiles", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vaz-db-migrate-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns only .sql files in lexical order", () => {
		writeFileSync(join(dir, "0001_add_locator.sql"), "");
		writeFileSync(join(dir, "0000_baseline.sql"), "");
		writeFileSync(join(dir, "README.md"), "not sql");
		expect(listMigrationFiles(dir)).toEqual(["0000_baseline.sql", "0001_add_locator.sql"]);
	});

	test("returns an empty list for a directory with no .sql files", () => {
		expect(listMigrationFiles(dir)).toEqual([]);
	});
});

describe("pendingMigrations", () => {
	test("excludes files already recorded as applied", () => {
		expect(
			pendingMigrations(["0000_baseline.sql", "0001_add_locator.sql"], ["0000_baseline.sql"]),
		).toEqual(["0001_add_locator.sql"]);
	});

	test("returns every file when none have been applied", () => {
		expect(pendingMigrations(["0000_baseline.sql"], [])).toEqual(["0000_baseline.sql"]);
	});

	test("returns an empty list once every file has been applied", () => {
		expect(pendingMigrations(["0000_baseline.sql"], ["0000_baseline.sql"])).toEqual([]);
	});

	test("preserves the input files' lexical order, not the applied list's order", () => {
		expect(
			pendingMigrations(
				["0000_baseline.sql", "0001_add_locator.sql", "0002_future.sql"],
				["0001_add_locator.sql"],
			),
		).toEqual(["0000_baseline.sql", "0002_future.sql"]);
	});
});

describe("resolveDatabaseUrl", () => {
	test("returns DATABASE_URL when set", () => {
		const url = "postgres://vaz:vaz@localhost:5432/vaz";
		expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
	});

	test("throws when DATABASE_URL is unset", () => {
		expect(() => resolveDatabaseUrl({})).toThrow();
	});

	test("throws when DATABASE_URL is blank", () => {
		expect(() => resolveDatabaseUrl({ DATABASE_URL: "  " })).toThrow();
	});
});

describe("createConsoleLogger", () => {
	test("returns a Logger with the four level methods", () => {
		const logger = createConsoleLogger();
		for (const level of ["debug", "info", "warn", "error"] as const) {
			expect(typeof logger[level]).toBe("function");
		}
	});
});

describe("isAlreadyExistsError", () => {
	test("recognizes Postgres's duplicate_table error code (42P07)", () => {
		expect(isAlreadyExistsError({ code: "42P07" })).toBe(true);
	});

	test("recognizes Postgres's duplicate_object error code (42710, enum/type)", () => {
		// The baseline DDL creates enums before tables, so a pre-existing
		// untracked DB hits `CREATE TYPE` → 42710 first — this must still route
		// to the fail-loud guidance (ADR-0002), not a raw driver error.
		expect(isAlreadyExistsError({ code: "42710" })).toBe(true);
	});

	test("rejects other Postgres error codes", () => {
		expect(isAlreadyExistsError({ code: "23505" })).toBe(false);
	});

	test("rejects non-error values", () => {
		expect(isAlreadyExistsError(null)).toBe(false);
		expect(isAlreadyExistsError("boom")).toBe(false);
		expect(isAlreadyExistsError(new Error("boom"))).toBe(false);
	});
});

describe("describeUntrackedExistingDatabase", () => {
	test("names the offending file and points to the fail-loud remediation (ADR-0002)", () => {
		const message = describeUntrackedExistingDatabase("0000_baseline.sql");
		expect(message).toContain("0000_baseline.sql");
		expect(message).toContain("_vaz_migration");
		expect(message).toContain("docs/adr/0002-ddl-migration-strategy.md");
	});

	test("does not claim the tracking table itself is missing (it always exists by this point)", () => {
		// applyMigrations runs `CREATE TABLE IF NOT EXISTS "_vaz_migration"`
		// unconditionally before this message can ever fire, so the table is
		// never actually absent — adversarial-review fix, 005.
		const message = describeUntrackedExistingDatabase("0000_baseline.sql");
		expect(message).not.toMatch(/no ".*" tracking table/i);
	});
});

describe("applyMigrations", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vaz-db-migrate-apply-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function testLogger() {
		return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	}

	/**
	 * A duck-typed Postgres client whose `query` dispatches on the SQL text:
	 * lock/unlock, tracking-table bookkeeping, and transaction control all
	 * short-circuit to a trivial success; anything else is treated as a
	 * migration file's own DDL body and routed through `onApplySql` (defaults
	 * to succeeding), so tests can simulate a specific file's failure.
	 * `failUnlock`/`failRelease` simulate the cleanup step itself failing, to
	 * verify cleanup failures never mask the real error (adversarial-review
	 * fix, 005).
	 */
	function fakeClient(
		options: {
			appliedRows?: string[];
			onApplySql?: (sql: string) => void;
			failUnlock?: boolean;
			failRelease?: boolean;
		} = {},
	) {
		const { appliedRows = [], onApplySql, failUnlock, failRelease } = options;
		const calls: string[] = [];
		const query = vi.fn(async (sql: string) => {
			calls.push(sql);
			const trimmed = sql.trim();
			if (trimmed.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
			if (trimmed.startsWith("SELECT pg_advisory_unlock")) {
				if (failUnlock) throw new Error("advisory unlock failed: connection terminated");
				return { rows: [] };
			}
			if (trimmed.startsWith('CREATE TABLE IF NOT EXISTS "_vaz_migration"')) return { rows: [] };
			if (trimmed.startsWith('SELECT "name" FROM "_vaz_migration"')) {
				return { rows: appliedRows.map((name) => ({ name })) };
			}
			if (trimmed === "BEGIN" || trimmed === "COMMIT" || trimmed === "ROLLBACK")
				return { rows: [] };
			if (trimmed.startsWith('INSERT INTO "_vaz_migration"')) return { rows: [] };
			onApplySql?.(sql);
			return { rows: [] };
		});
		const release = vi.fn(() => {
			if (failRelease) throw new Error("client release failed: already released");
		});
		return { query, release, calls };
	}

	function fakePool(client: ReturnType<typeof fakeClient>) {
		return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
	}

	test("applies pending files in lexical order, records each, and logs success", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TABLE a ();");
		writeFileSync(join(dir, "0001_add_locator.sql"), "ALTER TABLE a ADD COLUMN b text;");
		const client = fakeClient();
		const logger = testLogger();

		await applyMigrations(fakePool(client), dir, logger);

		expect(logger.info).toHaveBeenCalledWith("db:migrate: applied 0000_baseline.sql");
		expect(logger.info).toHaveBeenCalledWith("db:migrate: applied 0001_add_locator.sql");
		const applySqlCalls = client.calls.filter(
			(sql) => sql.includes("CREATE TABLE a") || sql.includes("ALTER TABLE a"),
		);
		expect(applySqlCalls).toEqual(["CREATE TABLE a ();", "ALTER TABLE a ADD COLUMN b text;"]);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	test("acquires the advisory lock before touching the tracking table, and releases it afterward", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TABLE a ();");
		const client = fakeClient();

		await applyMigrations(fakePool(client), dir, testLogger());

		const lockIndex = client.calls.findIndex((sql) => sql.includes("pg_try_advisory_lock"));
		const tableIndex = client.calls.findIndex((sql) => sql.includes("CREATE TABLE IF NOT EXISTS"));
		const unlockIndex = client.calls.findIndex((sql) => sql.includes("pg_advisory_unlock"));
		expect(lockIndex).toBeGreaterThanOrEqual(0);
		expect(lockIndex).toBeLessThan(tableIndex);
		expect(unlockIndex).toBe(client.calls.length - 1);
	});

	test("logs and takes no action when every file is already recorded as applied", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TABLE a ();");
		const client = fakeClient({ appliedRows: ["0000_baseline.sql"] });
		const logger = testLogger();

		await applyMigrations(fakePool(client), dir, logger);

		expect(logger.info).toHaveBeenCalledWith(
			"db:migrate: no pending migrations (already up to date)",
		);
		expect(client.calls).not.toContain("BEGIN");
		expect(client.calls.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(true);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	test("rolls back and converts a 42710 duplicate_object collision into the ADR-0002 fail-loud message", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TYPE job_status AS ENUM ();");
		const client = fakeClient({
			onApplySql: () => {
				throw { code: "42710" };
			},
		});

		await expect(applyMigrations(fakePool(client), dir, testLogger())).rejects.toThrow(
			/0000_baseline\.sql.*_vaz_migration.*0002-ddl-migration-strategy/s,
		);
		expect(client.calls).toContain("ROLLBACK");
		expect(client.calls).not.toContain("COMMIT");
		expect(client.calls.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(true);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	test("rolls back and rethrows a non-already-exists error unchanged", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TABLE a (broken syntax;");
		const client = fakeClient({
			onApplySql: () => {
				throw new Error('syntax error at or near "broken"');
			},
		});

		await expect(applyMigrations(fakePool(client), dir, testLogger())).rejects.toThrow(
			'syntax error at or near "broken"',
		);
		expect(client.calls).toContain("ROLLBACK");
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	test("preserves the real error and logs a warning when releasing the advisory lock also fails", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TABLE a (broken syntax;");
		const client = fakeClient({
			failUnlock: true,
			onApplySql: () => {
				throw new Error('syntax error at or near "broken"');
			},
		});
		const logger = testLogger();

		await expect(applyMigrations(fakePool(client), dir, logger)).rejects.toThrow(
			'syntax error at or near "broken"',
		);
		expect(logger.warn).toHaveBeenCalledWith(
			"db:migrate: failed to release advisory lock during cleanup",
			expect.objectContaining({ message: expect.stringContaining("connection terminated") }),
		);
		expect(client.release).toHaveBeenCalledTimes(1);
	});

	test("logs a warning but does not throw when client.release() itself fails during cleanup", async () => {
		writeFileSync(join(dir, "0000_baseline.sql"), "CREATE TABLE a ();");
		const client = fakeClient({ failRelease: true });
		const logger = testLogger();

		await applyMigrations(fakePool(client), dir, logger);

		expect(logger.warn).toHaveBeenCalledWith(
			"db:migrate: failed to release database client during cleanup",
			expect.objectContaining({ message: expect.stringContaining("already released") }),
		);
	});
});

describe("acquireAdvisoryLock", () => {
	function testLogger() {
		return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	}

	/** A minimal client whose `pg_try_advisory_lock` outcome is driven by `tryAcquire`. */
	function fakeLockClient(tryAcquire: () => boolean) {
		const calls: string[] = [];
		const query = vi.fn(async (sql: string) => {
			calls.push(sql.trim());
			if (sql.trim().startsWith("SELECT pg_try_advisory_lock")) {
				return { rows: [{ acquired: tryAcquire() }] };
			}
			return { rows: [] };
		});
		return { client: { query, release: vi.fn() } as unknown as PoolClient, calls };
	}

	test("returns immediately without sleeping when the lock is free on the first try", async () => {
		const { client } = fakeLockClient(() => true);
		const sleep = vi.fn().mockResolvedValue(undefined);

		await acquireAdvisoryLock(client, testLogger(), { sleep });

		expect(sleep).not.toHaveBeenCalled();
	});

	test("retries pg_try_advisory_lock, logging once (not per poll) while waiting", async () => {
		let attempts = 0;
		const { client } = fakeLockClient(() => {
			attempts += 1;
			return attempts >= 3;
		});
		const sleep = vi.fn().mockResolvedValue(undefined);
		const logger = testLogger();

		await acquireAdvisoryLock(client, logger, { sleep });

		expect(attempts).toBe(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(logger.info).toHaveBeenCalledTimes(1);
	});

	test("throws a clear timeout error instead of waiting forever when the lock is never released", async () => {
		const { client } = fakeLockClient(() => false);
		const sleep = vi.fn().mockResolvedValue(undefined);

		await expect(acquireAdvisoryLock(client, testLogger(), { sleep })).rejects.toThrow(
			/timed out.*advisory lock/is,
		);
	});
});
