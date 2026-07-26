import { emptyToUndefined } from "@vaz/schemas/env-helpers";
import { z } from "zod";

/**
 * Schema for infrastructure environment variables (R3.3): `DATABASE_URL`
 * (required — no sensible default to validate against) and `REDIS_URL`
 * (defaults to the docker compose service hostname). Same shape as
 * `aiEnvSchema`/`authEnvSchema`: a leaf-level `z.object` + `parse<Name>Env`.
 *
 * The schema only guarantees required-ness/trimming; it does not own the
 * user-facing error message. Callers (`apps/web/src/lib/db.ts`'s
 * `resolveWebDbEnv`, `apps/worker/src/start.ts`'s `resolveWorkerEnv`,
 * `packages/rag/bin/ingest.ts`'s `resolveDatabaseUrl`) each catch a parse
 * failure and raise their own pre-existing contextual message — refactor-only
 * (R3.4): those messages are unchanged from before this schema existed, so
 * each root's own tests keep passing on the exact same wording.
 *
 * `REDIS_URL` is trimmed before {@link emptyToUndefined} (rather than relying
 * on the schema's own `.trim()`) so a whitespace-only value falls back to the
 * default instead of failing validation — matching the pre-R3.2 behavior of
 * `env.REDIS_URL?.trim() || "redis://redis:6379"`.
 */
export const infraEnvSchema = z.object({
	DATABASE_URL: z.string().trim().min(1),
	REDIS_URL: z.string().trim().min(1).default("redis://redis:6379"),
});

export type InfraEnv = z.infer<typeof infraEnvSchema>;

export function parseInfraEnv(env: Record<string, string | undefined> = process.env): InfraEnv {
	return infraEnvSchema.parse({
		DATABASE_URL: emptyToUndefined(env.DATABASE_URL),
		REDIS_URL: emptyToUndefined(env.REDIS_URL?.trim()),
	});
}

/**
 * Reads only `REDIS_URL` off {@link infraEnvSchema} (`.pick`, so the default
 * stays single-sourced) for callers with no direct `DATABASE_URL` dependency
 * of their own — e.g. `apps/web/src/app/api/jobs/[id]/stream/route.ts`'s
 * `resolveRedisUrl`, which only subscribes to Redis pub/sub. Routing that
 * route through {@link parseInfraEnv} instead would wrongly make its Redis
 * subscription fail whenever `DATABASE_URL` happens to be unset.
 */
export function parseRedisUrl(env: Record<string, string | undefined> = process.env): string {
	return infraEnvSchema.pick({ REDIS_URL: true }).parse({
		REDIS_URL: emptyToUndefined(env.REDIS_URL?.trim()),
	}).REDIS_URL;
}
