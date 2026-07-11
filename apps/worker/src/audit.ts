import type { AgentDeps, AuditEntry, AuditSink } from "@vaz/schemas/deps";

/**
 * `apps/worker` audit DB sink (R5.5).
 *
 * R5.5: the platform SHALL record EVERY tool execution — who (`userId`), which
 * job (`jobId`), and with what arguments — to an audit log in the database.
 * This module supplies the worker-path implementation of the {@link AuditSink}
 * contract; the web path supplies its own (`apps/web/src/lib/audit.ts`)
 * against the same contract. The single FIRING POINT is the `@vaz/agents`
 * lifecycle audit hook, which calls `deps.audit.record(...)` for
 * every tool call on both paths — this module only persists.
 *
 * INJECTED PORT (ADR-2/ADR-3, mirroring `events.ts`): the DB is a seam
 * ({@link AuditLogStore}), so this module imports no `pg`/Drizzle. The container
 * edge supplies a Postgres-backed store and injects the sink via
 * `buildWorkerDeps({ audit })`; tests inject a fake, so no DB is needed.
 *
 * FAIL-LOUD — deliberately the opposite of the fail-soft events sink.
 * Event persistence is observability (a blip may be dropped); an audit record
 * is a security/compliance mandate ("record EVERY tool execution"), so a store
 * failure is logged and RE-THROWN rather than swallowed. The fail-open vs
 * fail-closed POLICY (does a failed audit block the tool?) belongs to the firing
 * point, which can decide per tool destructiveness (R5.3); the sink
 * only surfaces the outcome faithfully.
 *
 * R4.7 privacy: the arguments ARE persisted to the DB (that is R5.5's purpose),
 * but they are NEVER written to logs — a failure log carries only the
 * who/which-job/tool correlation, never the raw `args`.
 */

/**
 * Durable audit-log sink (DB). Appends one row per tool execution. The concrete
 * implementation (Drizzle insert into the `audit_log` table) is injected at the
 * container edge; the `audit_log` DDL is owned there.
 */
export interface AuditLogStore {
	insert(entry: AuditEntry): Promise<void> | void;
}

/** Injected dependencies for {@link createAuditSink}. `store` is REQUIRED: an
 * audit sink with no store would silently record nothing — a compliance hole.
 * (Phase 1's no-op auditing is expressed by omitting `deps.audit` entirely.) */
export interface CreateAuditSinkOptions {
	store: AuditLogStore;
}

/**
 * Build the worker's {@link AuditSink}. Each {@link AuditEntry} is persisted to
 * the audit-log store. On a store failure the error is logged with correlation
 * only (never the arguments — R4.7) and re-thrown so the firing point (Task
 * 20.2) can enforce its fail-open/closed policy.
 */
export function createAuditSink(deps: AgentDeps, options: CreateAuditSinkOptions): AuditSink {
	const { store } = options;

	return {
		async record(entry: AuditEntry): Promise<void> {
			try {
				await store.insert(entry);
			} catch (error) {
				// Correlation only — `entry.args` is potential PII/secrets and must
				// not reach the logs (R4.7); it is persisted to the DB, not logged.
				deps.logger.error("Failed to record tool execution to audit log", {
					userId: entry.userId,
					jobId: entry.jobId,
					tool: entry.tool,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	};
}
