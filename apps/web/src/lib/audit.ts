import type { AgentDeps, AuditSink } from "@vaz/schemas/deps";
import { createAuditSink as createWorkerAuditSink } from "@vaz/worker/src/audit";
import { createAuditLogStore } from "@vaz/worker/src/stores";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * `apps/web` audit DB sink (R5.5, Task 20.3).
 *
 * Supplies the web-path implementation of the `AuditSink` contract
 * (`@vaz/schemas/deps`), against which the worker-path sink
 * (`apps/worker/src/audit.ts`, Task 13.4) is also built — the single FIRING
 * POINT for both paths is the `@vaz/agents` lifecycle audit hook (Task 20.2);
 * this module only persists. Rather than duplicate the row-mapping/insert
 * logic, this reuses `@vaz/worker`'s already-tested `AuditLogStore` port
 * (`createAuditLogStore`, Task 13.8) and `createAuditSink` (fail-loud
 * persistence + R4.7-safe failure logging, Task 13.4). `apps/web` already
 * treats `@vaz/worker` as a reusable engine-side library for exactly this kind
 * of cross-runtime code — `apps/web/src/app/api/jobs/route.ts` and
 * `.../[id]/stream/route.ts` (Task 14.1/14.2) do the same for the durable
 * engine and the Redis publisher.
 *
 * The one NEW piece web needs is composing a Postgres client from its own env
 * (`DATABASE_URL`). Next.js Route Handlers run inside a long-lived process
 * (dev server, or a warm serverless container), so the `pg.Pool`/Drizzle
 * client is built lazily on first use and cached at module scope for the
 * process's lifetime, instead of opening a new pool per request (mirrors the
 * worker's `start.ts` composition root, adapted to a "no explicit boot"
 * runtime). `pg`/`drizzle-orm` are dynamic-imported so simply importing this
 * module (e.g. for `resolveWebAuditEnv`'s unit tests) never opens a real
 * connection — no DB is needed in tests.
 *
 * BOUNDARY: this is not yet wired into `apps/web/src/app/api/chat/route.ts` —
 * following the same "define the implementation now, wire it in a consumer
 * task later" precedent as Task 19.1/19.3/20.2 (no `deps.audit` caller exists
 * on the web path yet).
 */

/** Resolved web audit-sink configuration. */
export interface WebAuditEnv {
	databaseUrl: string;
}

/** Resolve the web audit sink's config from the environment (fail-fast, mirrors `apps/worker/src/start.ts`'s `resolveWorkerEnv`). */
export function resolveWebAuditEnv(
	env: Record<string, string | undefined> = process.env,
): WebAuditEnv {
	const databaseUrl = env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is required to build the web audit sink (e.g. postgres://vaz:vaz@db:5432/vaz)",
		);
	}
	return { databaseUrl };
}

let cachedDb: PgDatabase<PgQueryResultHKT> | undefined;

/** Lazily build (and process-cache) the Drizzle client backing the audit-log store. */
async function getWebAuditDb(
	env: Record<string, string | undefined>,
): Promise<PgDatabase<PgQueryResultHKT>> {
	if (!cachedDb) {
		const { databaseUrl } = resolveWebAuditEnv(env);
		const { Pool } = await import("pg");
		const { drizzle } = await import("drizzle-orm/node-postgres");
		cachedDb = drizzle(new Pool({ connectionString: databaseUrl }));
	}
	return cachedDb;
}

/**
 * Build the web-path `AuditSink`. Delegates persistence to `@vaz/worker`'s
 * `createAuditLogStore`/`createAuditSink` (fail-loud; R4.7-safe failure
 * logging) over a lazily-built, process-cached Postgres client. Recomposed on
 * every call (cheap, no I/O) so a per-request `deps` (e.g. its `logger`) is
 * always honored, while the expensive Postgres client is built at most once.
 */
export async function createAuditSink(
	deps: AgentDeps,
	env: Record<string, string | undefined> = process.env,
): Promise<AuditSink> {
	const db = await getWebAuditDb(env);
	return createWorkerAuditSink(deps, { store: createAuditLogStore(db) });
}
