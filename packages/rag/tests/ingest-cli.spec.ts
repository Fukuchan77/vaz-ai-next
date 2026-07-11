import { createConsoleLogger, parseIngestArgs, resolveDatabaseUrl } from "../bin/ingest";

/**
 * CLI composition-root pure logic (R2.6). The `ingest` command's argument and
 * environment parsing are unit-tested here; the Pool → Drizzle → ingest wiring
 * is an I/O boundary verified against a reachable database. Importing the
 * module must NOT run `main()` — the
 * entry is guarded by `import.meta.main`.
 */

describe("parseIngestArgs", () => {
	test("returns the corpus path from the first positional argument", () => {
		expect(parseIngestArgs(["./docs"])).toEqual({ corpusPath: "./docs" });
	});

	test("ignores extra positional arguments", () => {
		expect(parseIngestArgs(["./docs", "./more"])).toEqual({ corpusPath: "./docs" });
	});

	test("throws when no corpus path is given", () => {
		expect(() => parseIngestArgs([])).toThrow();
	});

	test("throws on a blank corpus path", () => {
		expect(() => parseIngestArgs(["   "])).toThrow();
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
