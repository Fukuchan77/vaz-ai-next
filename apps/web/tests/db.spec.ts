/**
 * `apps/web/src/lib/db.ts` — shared Postgres client for `apps/web` (audit sink,
 * job-ownership lookup, and the chat route's RAG wiring all reuse this one
 * lazily-built, process-cached client instead of opening their own pool).
 *
 * Mocks `pg`/`drizzle-orm/node-postgres` (no real Postgres needed) and resets
 * module state (the cached client) per test via `vi.resetModules()` + dynamic
 * import (mirrors the former per-consumer tests in `audit.spec.ts`/`jobs.spec.ts`).
 */

const { PoolMock, drizzleMock } = vi.hoisted(() => ({
	PoolMock: vi.fn(function PoolMock(opts: unknown) {
		return { __opts: opts };
	}),
	drizzleMock: vi.fn((pool: unknown) => ({ __pool: pool })),
}));

vi.mock("pg", () => ({ Pool: PoolMock }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: drizzleMock }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

describe("resolveWebDbEnv — fail-fast config (mirrors apps/worker/src/start.ts's resolveWorkerEnv)", () => {
	test("throws when DATABASE_URL is missing", async () => {
		const { resolveWebDbEnv } = await import("@/lib/db");
		expect(() => resolveWebDbEnv({})).toThrow(/DATABASE_URL/);
	});

	test("throws when DATABASE_URL is blank", async () => {
		const { resolveWebDbEnv } = await import("@/lib/db");
		expect(() => resolveWebDbEnv({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL/);
	});

	test("returns the trimmed databaseUrl when present", async () => {
		const { resolveWebDbEnv } = await import("@/lib/db");
		expect(resolveWebDbEnv({ DATABASE_URL: "  postgres://vaz:vaz@db:5432/vaz  " })).toEqual({
			databaseUrl: "postgres://vaz:vaz@db:5432/vaz",
		});
	});
});

describe("getWebDb — lazily builds and process-caches the Drizzle client", () => {
	const env = { DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz" };

	test("rejects when DATABASE_URL is missing (never touches Postgres)", async () => {
		const { getWebDb } = await import("@/lib/db");
		await expect(getWebDb({})).rejects.toThrow(/DATABASE_URL/);
		expect(PoolMock).not.toHaveBeenCalled();
	});

	test("builds the Pool from the resolved connectionString and wraps it with drizzle", async () => {
		const { getWebDb } = await import("@/lib/db");

		const db = await getWebDb(env);

		expect(PoolMock).toHaveBeenCalledWith({ connectionString: env.DATABASE_URL });
		expect(drizzleMock).toHaveBeenCalledTimes(1);
		expect(db).toBe(drizzleMock.mock.results[0]?.value);
	});

	test("caches the Postgres client across calls within the same process", async () => {
		const { getWebDb } = await import("@/lib/db");

		await getWebDb(env);
		await getWebDb(env);

		expect(PoolMock).toHaveBeenCalledTimes(1);
		expect(drizzleMock).toHaveBeenCalledTimes(1);
	});
});
