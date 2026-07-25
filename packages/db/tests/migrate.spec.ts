import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createConsoleLogger,
	describeUntrackedExistingDatabase,
	isDuplicateTableError,
	listMigrationFiles,
	pendingMigrations,
	resolveDatabaseUrl,
} from "../bin/migrate";

/**
 * `db:migrate` CLI pure logic (R2.3). File enumeration/ordering, the
 * unapplied-file diff, env parsing, and the untracked-existing-DB message are
 * unit-tested here without opening a database connection — the transactional
 * apply loop (`applyMigrations`) is an I/O boundary verified against a
 * reachable PostgreSQL (see `packages/db/tests/schema-ddl.spec.ts`'s sibling
 * DB-required verification in tasks.md 2.10). Importing this module must NOT
 * run `main()` — the entry is guarded by `import.meta.main`.
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

describe("isDuplicateTableError", () => {
	test("recognizes Postgres's duplicate_table error code (42P07)", () => {
		expect(isDuplicateTableError({ code: "42P07" })).toBe(true);
	});

	test("rejects other Postgres error codes", () => {
		expect(isDuplicateTableError({ code: "23505" })).toBe(false);
	});

	test("rejects non-error values", () => {
		expect(isDuplicateTableError(null)).toBe(false);
		expect(isDuplicateTableError("boom")).toBe(false);
		expect(isDuplicateTableError(new Error("boom"))).toBe(false);
	});
});

describe("describeUntrackedExistingDatabase", () => {
	test("names the offending file and points to the fail-loud remediation (ADR-0002)", () => {
		const message = describeUntrackedExistingDatabase("0000_baseline.sql");
		expect(message).toContain("0000_baseline.sql");
		expect(message).toContain("_vaz_migration");
		expect(message).toContain("docs/adr/0002-ddl-migration-strategy.md");
	});
});
