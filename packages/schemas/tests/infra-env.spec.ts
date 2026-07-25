import { infraEnvSchema, parseInfraEnv, parseRedisUrl } from "@vaz/schemas/infra-env";

/**
 * Infra env schema (R3.3): single-sources `DATABASE_URL` (required, no
 * sensible default) and `REDIS_URL` (defaults to the docker compose service
 * hostname) — same shape as `aiEnvSchema`/`authEnvSchema`. The schema only
 * guarantees required-ness/shape; call sites (`apps/web/src/lib/db.ts`,
 * `apps/worker/src/start.ts`, `packages/rag/bin/ingest.ts`) catch a parse
 * failure and raise their own pre-existing contextual message (R3.4,
 * refactor-only — verified by each call site's own spec, not here).
 */
describe("parseInfraEnv", () => {
	test("returns the trimmed DATABASE_URL and default REDIS_URL", () => {
		expect(parseInfraEnv({ DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz" })).toEqual({
			DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz",
			REDIS_URL: "redis://redis:6379",
		});
	});

	test("trims a padded DATABASE_URL and REDIS_URL", () => {
		expect(
			parseInfraEnv({
				DATABASE_URL: "  postgres://vaz:vaz@db:5432/vaz  ",
				REDIS_URL: "  redis://cache:6379  ",
			}),
		).toEqual({
			DATABASE_URL: "postgres://vaz:vaz@db:5432/vaz",
			REDIS_URL: "redis://cache:6379",
		});
	});

	test("throws when DATABASE_URL is missing", () => {
		expect(() => parseInfraEnv({})).toThrow();
	});

	test("throws when DATABASE_URL is an empty string", () => {
		expect(() => parseInfraEnv({ DATABASE_URL: "" })).toThrow();
	});

	test("throws when DATABASE_URL is blank (whitespace only)", () => {
		expect(() => parseInfraEnv({ DATABASE_URL: "   " })).toThrow();
	});

	test("defaults REDIS_URL to the compose service hostname when unset", () => {
		expect(parseInfraEnv({ DATABASE_URL: "postgres://x/y" }).REDIS_URL).toBe("redis://redis:6379");
	});

	test("treats an empty REDIS_URL string as unset (falls back to the default)", () => {
		expect(parseInfraEnv({ DATABASE_URL: "postgres://x/y", REDIS_URL: "" }).REDIS_URL).toBe(
			"redis://redis:6379",
		);
	});
});

describe("infraEnvSchema", () => {
	test("exposes DATABASE_URL and REDIS_URL fields", () => {
		expect(Object.keys(infraEnvSchema.shape)).toEqual(
			expect.arrayContaining(["DATABASE_URL", "REDIS_URL"]),
		);
	});
});

/**
 * `parseRedisUrl` (R3.4) — a narrower reader over the same schema's REDIS_URL
 * field for callers that only need Redis config (`apps/web/src/app/api/jobs/
 * [id]/stream/route.ts`'s `resolveRedisUrl`): it must never require
 * `DATABASE_URL`, since that route has no direct DB dependency of its own.
 */
describe("parseRedisUrl", () => {
	test("defaults to the compose service hostname when unset, without requiring DATABASE_URL", () => {
		expect(parseRedisUrl({})).toBe("redis://redis:6379");
	});

	test("returns a trimmed custom REDIS_URL", () => {
		expect(parseRedisUrl({ REDIS_URL: "  redis://cache:6379  " })).toBe("redis://cache:6379");
	});

	test("treats an empty string as unset (falls back to the default)", () => {
		expect(parseRedisUrl({ REDIS_URL: "" })).toBe("redis://redis:6379");
	});
});
