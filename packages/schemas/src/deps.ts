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
 * shapes only and never imports a concrete DB / logger / SDK. Because these
 * contracts carry functions (not serializable data), they are plain TypeScript
 * types rather than Zod schemas — validation lives in `env.ts` / `chat.ts`.
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
 * Minimal audit record for a single tool execution (who / job / tool / args, R5.5).
 * `userId` is null when unauthenticated (auth lands in Phase 5); `jobId` is null
 * on the synchronous chat path (no durable job). Finalized as the Zod
 * `AuditEntrySchema` in Task 20.1 (Phase 5).
 */
export interface AuditEntry {
	userId: string | null;
	jobId: string | null;
	tool: string;
	args: unknown;
	ts: Date;
}

/**
 * Audit sink for tool executions (R5.5). Optional on `AgentDeps`: when omitted,
 * auditing is a no-op (allowed in Phase 1). The single firing point is the
 * `@vaz/agents` lifecycle; web/worker inject a persisting implementation later.
 */
export interface AuditSink {
	record(entry: AuditEntry): void | Promise<void>;
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
	/** Optional; omitting it = no-op auditing (Phase 1). Finalized in Task 20.1. */
	audit?: AuditSink;
}
