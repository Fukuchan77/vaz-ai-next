/**
 * `apps/web/src/lib/jobs.ts` (R5.1) — web-path job-ownership lookup
 * + shared authorization (adversarial-review fix for the approve/stream
 * routes' duplicated authz block and the null-owner TOCTOU gap).
 *
 * Mirrors `apps/web/src/lib/audit.ts`'s pattern: reuse `@vaz/worker`'s
 * already-tested `JobStore` port (`createJobStore`) over the
 * shared, lazily built, process-cached Postgres client (`apps/web/src/lib/db.ts`,
 * tested separately in `db.spec.ts`), rather than duplicating the query. These
 * tests mock `@vaz/worker/src/stores`, `pg`/`drizzle-orm/node-postgres`, and
 * `@/lib/auth` (no real Postgres/session needed) and exercise only the NEW
 * logic: composing the port, and `authorizeJobAccess`'s policy.
 */

const { PoolMock, drizzleMock, createJobStoreMock, findOwnerUserIdMock, authMock } = vi.hoisted(
	() => ({
		PoolMock: vi.fn(function PoolMock(opts: unknown) {
			return { __opts: opts };
		}),
		drizzleMock: vi.fn((pool: unknown) => ({ __pool: pool })),
		findOwnerUserIdMock: vi.fn(),
		createJobStoreMock: vi.fn(),
		authMock: vi.fn(),
	}),
);

vi.mock("pg", () => ({ Pool: PoolMock }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: drizzleMock }));
vi.mock("@vaz/worker/src/stores", () => ({ createJobStore: createJobStoreMock }));
vi.mock("@/lib/auth", () => ({ auth: authMock }));

const JOB_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	createJobStoreMock.mockReturnValue({ insert: vi.fn(), findOwnerUserId: findOwnerUserIdMock });
});

describe("findJobOwnerUserId — composes @vaz/worker's port over the shared Postgres client (R5.1)", () => {
	const env = { DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz" };

	test("rejects when DATABASE_URL is missing (never touches Postgres)", async () => {
		const { findJobOwnerUserId } = await import("@/lib/jobs");
		await expect(findJobOwnerUserId(JOB_ID, {})).rejects.toThrow(/DATABASE_URL/);
		expect(PoolMock).not.toHaveBeenCalled();
	});

	test("builds the Pool from the resolved connectionString and delegates to JobStore.findOwnerUserId", async () => {
		findOwnerUserIdMock.mockResolvedValue({ found: true, userId: "user-1" });
		const { findJobOwnerUserId } = await import("@/lib/jobs");

		const owner = await findJobOwnerUserId(JOB_ID, env);

		expect(PoolMock).toHaveBeenCalledWith({ connectionString: env.DATABASE_URL });
		expect(drizzleMock).toHaveBeenCalledTimes(1);
		expect(createJobStoreMock).toHaveBeenCalledTimes(1);
		expect(findOwnerUserIdMock).toHaveBeenCalledWith(JOB_ID);
		expect(owner).toEqual({ found: true, userId: "user-1" });
	});

	test("returns found:false when the job has no row yet", async () => {
		findOwnerUserIdMock.mockResolvedValue({ found: false, userId: null });
		const { findJobOwnerUserId } = await import("@/lib/jobs");

		await expect(findJobOwnerUserId(JOB_ID, env)).resolves.toEqual({ found: false, userId: null });
	});

	test("caches the Postgres client across calls within the same process", async () => {
		findOwnerUserIdMock.mockResolvedValue({ found: false, userId: null });
		const { findJobOwnerUserId } = await import("@/lib/jobs");

		await findJobOwnerUserId(JOB_ID, env);
		await findJobOwnerUserId(JOB_ID, env);

		expect(PoolMock).toHaveBeenCalledTimes(1);
		expect(drizzleMock).toHaveBeenCalledTimes(1);
	});
});

describe("authorizeJobAccess — shared approve/stream authorization policy", () => {
	// authorizeJobAccess() has no env parameter (it's the route-facing surface,
	// always resolving against process.env) — unlike findJobOwnerUserId's tests
	// above, which pass an explicit env override.
	const originalDatabaseUrl = process.env.DATABASE_URL;
	beforeEach(() => {
		process.env.DATABASE_URL = "postgres://vaz:vaz@db:5432/vaz";
	});
	afterEach(() => {
		process.env.DATABASE_URL = originalDatabaseUrl;
	});

	function withSession(userId: string | null) {
		authMock.mockResolvedValue(userId ? { user: { id: userId } } : null);
	}

	test("400s on a malformed job id (never calls auth or the DB)", async () => {
		const { authorizeJobAccess } = await import("@/lib/jobs");

		const result = await authorizeJobAccess("not-a-uuid");

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(400);
		expect(authMock).not.toHaveBeenCalled();
	});

	test("401s when there is no authenticated session", async () => {
		withSession(null);
		const { authorizeJobAccess } = await import("@/lib/jobs");

		const result = await authorizeJobAccess(JOB_ID);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(401);
	});

	test("404s when the job has no row yet (closes the TOCTOU race — not silently authorized)", async () => {
		withSession("user-1");
		findOwnerUserIdMock.mockResolvedValue({ found: false, userId: null });
		const { authorizeJobAccess } = await import("@/lib/jobs");

		const result = await authorizeJobAccess(JOB_ID);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(404);
	});

	test("403s when the job is owned by someone else", async () => {
		withSession("user-2");
		findOwnerUserIdMock.mockResolvedValue({ found: true, userId: "user-1" });
		const { authorizeJobAccess } = await import("@/lib/jobs");

		const result = await authorizeJobAccess(JOB_ID);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.response.status).toBe(403);
	});

	test("grants the owner", async () => {
		withSession("user-1");
		findOwnerUserIdMock.mockResolvedValue({ found: true, userId: "user-1" });
		const { authorizeJobAccess } = await import("@/lib/jobs");

		const result = await authorizeJobAccess(JOB_ID);

		expect(result).toEqual({ ok: true, callerId: "user-1" });
	});

	test("grants any authenticated caller for a found job with no recorded owner (intentional anonymous-submission bypass)", async () => {
		withSession("user-2");
		findOwnerUserIdMock.mockResolvedValue({ found: true, userId: null });
		const { authorizeJobAccess } = await import("@/lib/jobs");

		const result = await authorizeJobAccess(JOB_ID);

		expect(result).toEqual({ ok: true, callerId: "user-2" });
	});
});
