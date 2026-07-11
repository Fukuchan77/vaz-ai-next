import type { AgentDeps, AuditSink } from "@vaz/schemas/deps";
import { createAuditSink as createWorkerAuditSink } from "@vaz/worker/src/audit";
import { createAuditLogStore } from "@vaz/worker/src/stores";
import { getWebDb } from "./db";

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
 * The Postgres client itself (`getWebDb`, `apps/web/src/lib/db.ts`) is shared
 * with `apps/web/src/lib/jobs.ts` and the chat route's RAG wiring — one
 * process-cached pool per `DATABASE_URL`, not one per consumer.
 *
 * Wired into `apps/web/src/app/api/chat/route.ts` (adversarial-review fix):
 * `deps.audit` is now populated whenever `DATABASE_URL` is configured.
 */

/**
 * Build the web-path `AuditSink`. Delegates persistence to `@vaz/worker`'s
 * `createAuditLogStore`/`createAuditSink` (fail-loud; R4.7-safe failure
 * logging) over the shared, lazily-built, process-cached Postgres client.
 * Recomposed on every call (cheap, no I/O) so a per-request `deps` (e.g. its
 * `logger`) is always honored, while the expensive Postgres client is built
 * at most once.
 */
export async function createAuditSink(
	deps: AgentDeps,
	env: Record<string, string | undefined> = process.env,
): Promise<AuditSink> {
	const db = await getWebDb(env);
	return createWorkerAuditSink(deps, { store: createAuditLogStore(db) });
}
