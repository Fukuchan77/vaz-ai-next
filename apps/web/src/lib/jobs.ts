import { createJobStore } from "@vaz/worker/src/stores";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * `apps/web` job-ownership lookup (R5.1, Task 21.4).
 *
 * Mirrors `apps/web/src/lib/audit.ts` exactly: reuses `@vaz/worker`'s
 * already-tested `JobStore` port (`createJobStore`, Task 21.3) over a lazily
 * built, process-cached Postgres client, instead of duplicating the query.
 * The approve/stream routes (`apps/web/src/app/api/jobs/[id]/{approve,stream}
 * /route.ts`) call `findJobOwnerUserId` to authorize a caller against the job
 * they are acting on.
 */

/** Resolved web job-lookup configuration. */
export interface WebJobsEnv {
	databaseUrl: string;
}

/** Resolve the web job-lookup config from the environment (fail-fast, mirrors `resolveWebAuditEnv`). */
export function resolveWebJobsEnv(
	env: Record<string, string | undefined> = process.env,
): WebJobsEnv {
	const databaseUrl = env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is required to look up job ownership (e.g. postgres://vaz:vaz@db:5432/vaz)",
		);
	}
	return { databaseUrl };
}

let cachedDb: PgDatabase<PgQueryResultHKT> | undefined;

/** Lazily build (and process-cache) the Drizzle client backing the job store. */
async function getWebJobsDb(
	env: Record<string, string | undefined>,
): Promise<PgDatabase<PgQueryResultHKT>> {
	if (!cachedDb) {
		const { databaseUrl } = resolveWebJobsEnv(env);
		const { Pool } = await import("pg");
		const { drizzle } = await import("drizzle-orm/node-postgres");
		cachedDb = drizzle(new Pool({ connectionString: databaseUrl }));
	}
	return cachedDb;
}

/**
 * The `userId` that owns `jobId` (`job.userId`, persisted at job start by
 * `runJob`, Task 21.3), or `null` when the job has no recorded owner (not yet
 * inserted, unknown, or submitted anonymously — R5.1's Phase 5 deferral for
 * unauthenticated submission).
 */
export async function findJobOwnerUserId(
	jobId: string,
	env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
	const db = await getWebJobsDb(env);
	return createJobStore(db).findOwnerUserId(jobId);
}
