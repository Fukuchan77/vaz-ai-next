import { resolveWorkerEnv } from "../src/start";

/**
 * Task 13.9 — worker boot env parsing. Only the pure config resolution is
 * unit-tested here (mirrors `@vaz/rag`'s ingest CLI); the live `main()` opens
 * real Postgres/Redis/Inngest connections and is verified against a running
 * stack (Task 8.1 FLAG → Task 15 durable E2E).
 *
 * Task 21.1 adds one exception: `main()`'s resource-release-on-any-exit-path
 * invariant (the `finally` block) is unit-testable network-free by mocking
 * every infra import (`pg`/`drizzle-orm`/`redis`/`inngest/connect`) plus the
 * sibling worker modules `main()` composes deps from — no real connection is
 * ever attempted.
 */

describe("resolveWorkerEnv", () => {
	test("resolves DATABASE_URL + REDIS_URL + instanceId", () => {
		expect(
			resolveWorkerEnv({
				DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz",
				REDIS_URL: "redis://cache:6379",
				WORKER_INSTANCE_ID: "worker-1",
			}),
		).toEqual({
			databaseUrl: "postgres://vaz:vaz@db:5432/vaz",
			redisUrl: "redis://cache:6379",
			instanceId: "worker-1",
		});
	});

	test("defaults REDIS_URL and leaves instanceId undefined (hostname default)", () => {
		const env = resolveWorkerEnv({ DATABASE_URL: "postgres://x/y" });
		expect(env.redisUrl).toBe("redis://redis:6379");
		expect(env.instanceId).toBeUndefined();
	});

	test("throws when DATABASE_URL is missing (fail-fast)", () => {
		expect(() => resolveWorkerEnv({})).toThrow(/DATABASE_URL is required/);
	});
});

describe("main() resource release on boot failure (Task 21.1)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("pg");
		vi.doUnmock("drizzle-orm/node-postgres");
		vi.doUnmock("redis");
		vi.doUnmock("inngest/connect");
		vi.doUnmock("../src/main");
		vi.doUnmock("../src/audit");
		vi.doUnmock("../src/stores");
		vi.doUnmock("../src/events");
		vi.doUnmock("../src/publisher");
	});

	test("releases the pg pool and redis client when redisClient.connect() rejects", async () => {
		const poolEnd = vi.fn().mockResolvedValue(undefined);
		const redisQuit = vi.fn().mockResolvedValue(undefined);
		const redisConnect = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

		vi.doMock("pg", () => ({
			Pool: vi.fn().mockImplementation(function PoolMock() {
				return { end: poolEnd };
			}),
		}));
		vi.doMock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn().mockReturnValue({}) }));
		vi.doMock("redis", () => ({
			createClient: vi
				.fn()
				.mockReturnValue({ on: vi.fn(), connect: redisConnect, quit: redisQuit }),
		}));
		vi.doMock("inngest/connect", () => ({ connect: vi.fn() }));
		vi.doMock("../src/main", () => ({ buildWorkerDeps: vi.fn().mockReturnValue({}) }));
		vi.doMock("../src/audit", () => ({ createAuditSink: vi.fn().mockReturnValue({}) }));
		vi.doMock("../src/stores", () => ({
			createAuditLogStore: vi.fn(),
			createJobEventStore: vi.fn(),
		}));
		vi.doMock("../src/events", () => ({ createJobEventSink: vi.fn() }));
		vi.doMock("../src/publisher", () => ({ createJobEventPublisher: vi.fn() }));

		const { main } = await import("../src/start");

		await expect(
			main({ DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz", REDIS_URL: "redis://cache:6379" }),
		).rejects.toThrow("ECONNREFUSED");

		expect(poolEnd).toHaveBeenCalledTimes(1);
		expect(redisQuit).toHaveBeenCalledTimes(1);
	});
});

describe("main() job-store wiring (R5.1, Task 21.3)", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.doUnmock("pg");
		vi.doUnmock("drizzle-orm/node-postgres");
		vi.doUnmock("redis");
		vi.doUnmock("inngest/connect");
		vi.doUnmock("./inngest");
		vi.doUnmock("../src/inngest");
		vi.doUnmock("../src/main");
		vi.doUnmock("../src/audit");
		vi.doUnmock("../src/stores");
		vi.doUnmock("../src/events");
		vi.doUnmock("../src/publisher");
	});

	test("passes a JobStore built over the composed db into registerJobFunction", async () => {
		const jobStoreSentinel = { insert: vi.fn(), findOwnerUserId: vi.fn() };
		const registerJobFunction = vi.fn().mockReturnValue({});

		vi.doMock("pg", () => ({
			Pool: vi.fn().mockImplementation(function PoolMock() {
				return { end: vi.fn().mockResolvedValue(undefined) };
			}),
		}));
		vi.doMock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn().mockReturnValue({}) }));
		vi.doMock("redis", () => ({
			createClient: vi.fn().mockReturnValue({
				on: vi.fn(),
				connect: vi.fn().mockResolvedValue(undefined),
				quit: vi.fn().mockResolvedValue(undefined),
			}),
		}));
		vi.doMock("inngest/connect", () => ({
			connect: vi.fn().mockResolvedValue({ connectionId: "conn-1", closed: Promise.resolve() }),
		}));
		vi.doMock("../src/inngest", () => ({
			createInngestEngine: vi.fn().mockResolvedValue({}),
			registerJobFunction,
		}));
		vi.doMock("../src/main", () => ({ buildWorkerDeps: vi.fn().mockReturnValue({}) }));
		vi.doMock("../src/audit", () => ({ createAuditSink: vi.fn().mockReturnValue({}) }));
		vi.doMock("../src/stores", () => ({
			createAuditLogStore: vi.fn(),
			createJobEventStore: vi.fn(),
			createJobStore: vi.fn().mockReturnValue(jobStoreSentinel),
		}));
		vi.doMock("../src/events", () => ({ createJobEventSink: vi.fn() }));
		vi.doMock("../src/publisher", () => ({ createJobEventPublisher: vi.fn() }));

		const { main } = await import("../src/start");
		await main({ DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz", REDIS_URL: "redis://cache:6379" });

		expect(registerJobFunction).toHaveBeenCalledTimes(1);
		const options = registerJobFunction.mock.calls[0]?.[2];
		expect(options?.jobStore).toBe(jobStoreSentinel);
	});
});
