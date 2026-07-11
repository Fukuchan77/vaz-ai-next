import { z } from "zod";

/**
 * Agent dependency contracts (ADR-3: deps-closure injection).
 *
 * `AgentDeps` is the single injection surface handed to agent and capability
 * factories — `createChatAgent(deps)` (R1.3), `createTimeCapability(deps)` (R1.4).
 * Runtime concerns (DB access, logging, clock, audit) are injected here so that:
 *   - capabilities read them from closure and stay unit-testable (no ambient globals), and
 *   - agents receive them without importing concrete runtime implementations.
 *
 * This module lives in `@vaz/schemas`, the dependency-graph leaf: it declares
 * shapes only and never imports a concrete DB / logger / SDK. Most of these
 * contracts carry functions (`Logger`, `Clock`, `AuditSink`) and stay plain
 * TypeScript types — a Zod schema cannot express a function member. The one
 * exception is {@link auditEntrySchema}: `AuditEntry` is plain data (no
 * functions) crossing a real validation boundary (the audit-log DB sinks,
 * R5.5), so Task 20.1 promotes it from a plain interface to a Zod schema.
 */

/**
 * Structured metadata attached to a single log record.
 *
 * PRIVACY CONTRACT (R4.7, behavioral — not type-enforced; `Record<string,
 * unknown>` accepts anything, so nothing here is checked by the compiler):
 * `fields` MUST NOT contain a raw user prompt or raw/full tool input or
 * output (potential PII or secrets), on any of `Logger`'s four methods, by
 * default. Recording such a payload is opt-in — it requires a deliberate,
 * purpose-built decision by the call site or implementation (e.g. a
 * dedicated debugging path gated behind its own flag), never the default
 * behavior of an ordinary log call. The safe default is to log a
 * non-sensitive identifier instead of the payload itself — e.g.
 * `packages/tools/src/email.ts`'s `email.sent` log records `{ messageId }`,
 * never the sent subject/body.
 */
export type LogFields = Record<string, unknown>;

/**
 * Logging contract for agents and capabilities (R4.7). See {@link LogFields}
 * for the PII/opt-in privacy contract that governs every method below.
 */
export interface Logger {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
}

/**
 * Injected clock. Capabilities read the current time through this instead of
 * `new Date()` so unit tests can pin time deterministically (R1.4).
 */
export type Clock = () => Date;

/**
 * Minimal audit record for a single tool execution (who / job / tool / args, R5.5;
 * Task 20.1, finalized from Task 2.4's plain-interface draft). `userId` is null
 * when unauthenticated (auth lands in Phase 5); `jobId` is a `job.id` uuid, null
 * on the synchronous chat path (no durable job) — mirrors `jobEventSchema`'s
 * `jobId: z.uuid()` (`@vaz/schemas/workflows`) since both correlate to the same
 * `job` table row. `args` is intentionally `unknown`: it is tool-specific and
 * validated at the tool boundary, not re-constrained here.
 *
 * `ts` is a `Date`, NOT the ISO string `jobEventSchema` uses for its `ts` — that
 * choice exists because a `JobEvent` is serialized over SSE to the browser,
 * while an `AuditEntry` is only ever passed in-process (agent lifecycle hook →
 * `deps.audit.record(...)` → the DB sink's own row mapper), so no
 * serialization boundary requires a wire-safe string here.
 */
export const auditEntrySchema = z.object({
	userId: z.string().nullable(),
	jobId: z.uuid().nullable(),
	tool: z.string().min(1),
	args: z.unknown(),
	ts: z.date(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/**
 * Audit sink for tool executions (R5.5). Optional on `AgentDeps`: when omitted,
 * auditing is a no-op (allowed in Phase 1). The single firing point is the
 * `@vaz/agents` lifecycle; web/worker inject a persisting implementation later.
 */
export interface AuditSink {
	record(entry: AuditEntry): void | Promise<void>;
}

/**
 * The authenticated caller's identity/permissions for a single request (R5.1,
 * Task 18.3), mapped from the Auth.js session by `apps/web/src/lib/auth.ts`'s
 * `toRuntimeContext`. `role` is a plain string (not `@vaz/config`'s `VazRole`
 * enum) because this leaf package cannot depend on `@vaz/config` —
 * `AuthRuntimeContext` (`apps/web/src/lib/auth.ts`) is structurally
 * compatible. Both fields are `null` for an unauthenticated request.
 */
export interface RuntimeContext {
	userId: string | null;
	role: string | null;
}

/**
 * Dependency bundle injected into agents and capabilities (ADR-3).
 *
 * `DB` is generic because the concrete client (Drizzle, Phase 2) lives outside
 * this leaf package; Phase 1 is stateless and leaves it as `unknown`. Phase 2
 * consumers narrow it, e.g. `AgentDeps<PostgresJsDatabase>`.
 */
export interface AgentDeps<DB = unknown> {
	db: DB;
	logger: Logger;
	now: Clock;
	/** Optional; omitting it = no-op auditing (Phase 1). `AuditEntry` shape finalized as {@link auditEntrySchema} in Task 20.1. */
	audit?: AuditSink;
	/**
	 * Optional; omitting it means an unauthenticated/system-initiated call
	 * (Phase 1/pre-18.3 behavior unchanged). Populated per-request by
	 * `apps/web/src/app/api/chat/route.ts` (R5.1, Task 18.3) as the seam a
	 * future tool-permission check reads from — no capability branches on it
	 * yet (mirrors the `audit` field's "declared ahead of its consumer" precedent).
	 */
	runtimeContext?: RuntimeContext;
}
