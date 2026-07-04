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

/** Structured metadata attached to a single log record. */
export type LogFields = Record<string, unknown>;

/**
 * Logging contract for agents and capabilities (R4.7).
 *
 * PRIVACY CONTRACT: implementations MUST NOT record raw prompts or raw tool
 * input/output (potential PII / secrets) at `info` and below by default;
 * recording such sensitive payloads is opt-in. This contract is made explicit
 * (INFO default-off, sensitive-payload opt-in) in Task 16.3 (Phase 4).
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
