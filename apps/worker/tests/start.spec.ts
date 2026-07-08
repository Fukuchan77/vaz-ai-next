import { resolveWorkerEnv } from "../src/start";

/**
 * Task 13.9 — worker boot env parsing. Only the pure config resolution is
 * unit-tested here (mirrors `@vaz/rag`'s ingest CLI); the live `main()` opens
 * real Postgres/Redis/Inngest connections and is verified against a running
 * stack (Task 8.1 FLAG → Task 15 durable E2E).
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
