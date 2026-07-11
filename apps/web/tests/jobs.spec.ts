/**
 * `apps/web/src/lib/jobs.ts` (R5.1, Task 21.4) — web-path job-ownership lookup.
 *
 * Mirrors `apps/web/src/lib/audit.ts`'s pattern exactly: reuse `@vaz/worker`'s
 * already-tested `JobStore` port (`createJobStore`, Task 21.3) over a lazily
 * built, process-cached Postgres client, rather than duplicating the query.
 * These tests mock `@vaz/worker/src/stores` (already covered by
 * `apps/worker/tests/stores.spec.ts`) and `pg`/`drizzle-orm/node-postgres` (no
 * real Postgres needed) and exercise only the NEW logic: env resolution
 * (fail-fast) and the lazy, process-cached client. Module state (the cached
 * client) is reset per test via `vi.resetModules()` + dynamic import (mirrors
 * `audit.spec.ts`/`telemetry.spec.ts`).
 */

const { PoolMock, drizzleMock, createJobStoreMock, findOwnerUserIdMock } = vi.hoisted(() => ({
	PoolMock: vi.fn(function PoolMock(opts: unknown) {
		return { __opts: opts };
	}),
	drizzleMock: vi.fn((pool: unknown) => ({ __pool: pool })),
	findOwnerUserIdMock: vi.fn(),
	createJobStoreMock: vi.fn(),
}));

vi.mock("pg", () => ({ Pool: PoolMock }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: drizzleMock }));
vi.mock("@vaz/worker/src/stores", () => ({ createJobStore: createJobStoreMock }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	createJobStoreMock.mockReturnValue({ insert: vi.fn(), findOwnerUserId: findOwnerUserIdMock });
});

describe("resolveWebJobsEnv — fail-fast config (mirrors resolveWebAuditEnv)", () => {
	test("throws when DATABASE_URL is missing", async () => {
		const { resolveWebJobsEnv } = await import("@/lib/jobs");
		expect(() => resolveWebJobsEnv({})).toThrow(/DATABASE_URL/);
	});

	test("returns the trimmed databaseUrl when present", async () => {
		const { resolveWebJobsEnv } = await import("@/lib/jobs");
		expect(resolveWebJobsEnv({ DATABASE_URL: "  postgres://vaz:vaz@db:5432/vaz  " })).toEqual({
			databaseUrl: "postgres://vaz:vaz@db:5432/vaz",
		});
	});
});

describe("findJobOwnerUserId — composes @vaz/worker's port over a lazily-built Postgres client (R5.1)", () => {
	const env = { DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz" };
	const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

	test("rejects when DATABASE_URL is missing (never touches Postgres)", async () => {
		const { findJobOwnerUserId } = await import("@/lib/jobs");
		await expect(findJobOwnerUserId(jobId, {})).rejects.toThrow(/DATABASE_URL/);
		expect(PoolMock).not.toHaveBeenCalled();
	});

	test("builds the Pool from the resolved connectionString and delegates to JobStore.findOwnerUserId", async () => {
		findOwnerUserIdMock.mockResolvedValue("user-1");
		const { findJobOwnerUserId } = await import("@/lib/jobs");

		const owner = await findJobOwnerUserId(jobId, env);

		expect(PoolMock).toHaveBeenCalledWith({ connectionString: env.DATABASE_URL });
		expect(drizzleMock).toHaveBeenCalledTimes(1);
		expect(createJobStoreMock).toHaveBeenCalledTimes(1);
		expect(findOwnerUserIdMock).toHaveBeenCalledWith(jobId);
		expect(owner).toBe("user-1");
	});

	test("returns null when the job has no recorded owner", async () => {
		findOwnerUserIdMock.mockResolvedValue(null);
		const { findJobOwnerUserId } = await import("@/lib/jobs");

		await expect(findJobOwnerUserId(jobId, env)).resolves.toBeNull();
	});

	test("caches the Postgres client across calls within the same process", async () => {
		findOwnerUserIdMock.mockResolvedValue(null);
		const { findJobOwnerUserId } = await import("@/lib/jobs");

		await findJobOwnerUserId(jobId, env);
		await findJobOwnerUserId(jobId, env);

		expect(PoolMock).toHaveBeenCalledTimes(1);
		expect(drizzleMock).toHaveBeenCalledTimes(1);
	});
});
