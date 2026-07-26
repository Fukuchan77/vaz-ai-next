import { parseInfraEnv } from "@vaz/schemas/infra-env";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * `apps/web` shared Postgres client (adversarial-review fix).
 *
 * `apps/web/src/lib/audit.ts` and `apps/web/src/lib/jobs.ts` each used to build
 * and process-cache their own `pg.Pool`/Drizzle client against the same
 * `DATABASE_URL`, doubling idle connections for one logical database. Both —
 * and now `apps/web/src/app/api/chat/route.ts`'s RAG wiring — share this one
 * lazily-built, process-cached client instead.
 *
 * `pg`/`drizzle-orm` are dynamic-imported so importing this module (e.g. for
 * `resolveWebDbEnv`'s unit tests) never opens a real connection.
 */

/** Resolved web DB configuration. */
export interface WebDbEnv {
	databaseUrl: string;
}

/** Resolve the web DB config from the environment (fail-fast on a missing `DATABASE_URL`). */
export function resolveWebDbEnv(env: Record<string, string | undefined> = process.env): WebDbEnv {
	try {
		return { databaseUrl: parseInfraEnv(env).DATABASE_URL };
	} catch {
		throw new Error("DATABASE_URL is required (e.g. postgres://vaz:vaz@db:5432/vaz)");
	}
}

let cachedDb: PgDatabase<PgQueryResultHKT> | undefined;

/** Lazily build (and process-cache) the Drizzle client shared by every `apps/web` DB consumer. */
export async function getWebDb(
	env: Record<string, string | undefined> = process.env,
): Promise<PgDatabase<PgQueryResultHKT>> {
	if (!cachedDb) {
		const { databaseUrl } = resolveWebDbEnv(env);
		const { Pool } = await import("pg");
		const { drizzle } = await import("drizzle-orm/node-postgres");
		cachedDb = drizzle(new Pool({ connectionString: databaseUrl }));
	}
	return cachedDb;
}
