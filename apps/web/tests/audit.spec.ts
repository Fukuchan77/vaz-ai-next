import type { AgentDeps } from "@vaz/schemas/deps";

/**
 * `apps/web/src/lib/audit.ts` (R5.5) — web-path `deps.audit` DB sink.
 *
 * Rather than duplicate the row-mapping/insert logic, this module reuses
 * `@vaz/worker`'s already-tested `AuditLogStore` port (`createAuditLogStore`)
 * and `createAuditSink` (fail-loud persistence + R4.7-safe failure
 * logging) — `apps/web` already treats `@vaz/worker` as a reusable
 * engine-side library for this (`api/jobs/route.ts`/`.../stream/route.ts`,
 * reuse `@vaz/worker/src/inngest`/`main`/`publisher` the same
 * way). So these tests mock `@vaz/worker/src/audit`/`stores` (already covered
 * by `apps/worker/tests/audit.spec.ts`/`stores.spec.ts`) and `pg`/
 * `drizzle-orm/node-postgres` (no real Postgres needed), and exercise only the
 * NEW logic: composing `@vaz/worker`'s port over the shared, lazily-built
 * Postgres client (`apps/web/src/lib/db.ts`, tested separately in
 * `db.spec.ts`). Module state (the cached client) is reset per test via
 * `vi.resetModules()` + dynamic import (mirrors `telemetry.spec.ts`).
 */

const { PoolMock, drizzleMock, createAuditLogStoreMock, createSinkMock } = vi.hoisted(() => ({
	PoolMock: vi.fn(function PoolMock(opts: unknown) {
		return { __opts: opts };
	}),
	drizzleMock: vi.fn((pool: unknown) => ({ __pool: pool })),
	createAuditLogStoreMock: vi.fn((db: unknown) => ({ __store: db })),
	createSinkMock: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock("pg", () => ({ Pool: PoolMock }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: drizzleMock }));
vi.mock("@vaz/worker/src/stores", () => ({ createAuditLogStore: createAuditLogStoreMock }));
vi.mock("@vaz/worker/src/audit", () => ({ createAuditSink: createSinkMock }));

function makeDeps(): AgentDeps {
	return {
		db: null,
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		now: () => new Date("2026-07-11T00:00:00.000Z"),
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

describe("createAuditSink (web) — composes @vaz/worker's port over a lazily-built Postgres client (R5.5)", () => {
	const env = { DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz" };

	test("rejects when DATABASE_URL is missing (never touches Postgres)", async () => {
		const { createAuditSink } = await import("@/lib/audit");
		await expect(createAuditSink(makeDeps(), {})).rejects.toThrow(/DATABASE_URL/);
		expect(PoolMock).not.toHaveBeenCalled();
	});

	test("builds the Pool from the resolved connectionString and wires drizzle → createAuditLogStore → createAuditSink", async () => {
		const { createAuditSink } = await import("@/lib/audit");
		const deps = makeDeps();

		const sink = await createAuditSink(deps, env);

		expect(PoolMock).toHaveBeenCalledWith({ connectionString: env.DATABASE_URL });
		expect(drizzleMock).toHaveBeenCalledTimes(1);
		expect(createAuditLogStoreMock).toHaveBeenCalledTimes(1);
		expect(createSinkMock).toHaveBeenCalledWith(deps, {
			store: createAuditLogStoreMock.mock.results[0]?.value,
		});
		expect(sink).toBe(createSinkMock.mock.results[0]?.value);
	});

	test("caches the Postgres client across calls within the same process (builds the Pool only once)", async () => {
		const { createAuditSink } = await import("@/lib/audit");
		const deps = makeDeps();

		await createAuditSink(deps, env);
		await createAuditSink(deps, env);

		expect(PoolMock).toHaveBeenCalledTimes(1);
		expect(drizzleMock).toHaveBeenCalledTimes(1);
		// the sink itself is (re)composed per call (deps can differ per request)
		expect(createSinkMock).toHaveBeenCalledTimes(2);
	});
});
