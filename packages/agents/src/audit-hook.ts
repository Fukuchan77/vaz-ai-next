import type { AgentDeps } from "@vaz/schemas/deps";
import type { OnToolExecutionStartCallback } from "ai";

/**
 * Tool-execution audit hook (R5.5) — the single firing point `@vaz/agents`
 * owns for every tool call, on both the web (chat) and worker (workflow)
 * paths. Neither path persists here: `deps.audit` is the injected
 * `AuditSink` (`@vaz/schemas/deps`), supplied per-path by
 * `apps/web/src/lib/audit.ts` and `apps/worker/src/audit.ts`.
 * This module only decides WHEN to call `deps.audit.record(...)`
 * and WHAT goes in the entry; persistence and its own failure policy belong
 * to the sink.
 *
 * LIFECYCLE POINT: `streamText`/`generateText`'s `onToolExecutionStart`
 * (ai@7.0.14) fires once per tool call, after any `toolApproval` gate has let
 * it through and just before the tool's own `execute` runs — matching R5.5
 * ("record EVERY tool execution"): a call denied approval never executes and
 * is not this module's concern.
 *
 * FAIL-OPEN BY SDK CONSTRUCTION, NOT POLICY CHOICE: `ai`'s internal `notify()`
 * (`node_modules/ai/dist/index.js`) awaits every `onToolExecutionStart`
 * callback inside a try/catch that silently discards whatever it throws, so
 * nothing this hook does can pause or fail a tool call — a sink failure is
 * therefore always fail-open at this lifecycle point, regardless of the
 * sink's own fail-loud contract (e.g. `apps/worker/src/audit.ts` rethrows to
 * *its* caller, which is this hook, not the tool loop). This hook still
 * catches that rejection itself and reports it via `deps.logger.error`
 * (correlation fields only — never `args`, R4.7) so the failure is visible
 * somewhere instead of vanishing into the SDK's swallow.
 */

/** Construction-time configuration for {@link createAuditHook}. */
export interface CreateAuditHookOptions {
	/**
	 * Correlates every recorded entry to a durable job (`job.id`). Omit on the
	 * synchronous chat path (no job) — recorded as `null`, mirroring
	 * `auditEntrySchema`'s `jobId` contract (`@vaz/schemas/deps`).
	 */
	jobId?: string;
}

/** The hook's public shape: spread directly into a `streamText`/`generateText` call. */
export interface AuditHook {
	onToolExecutionStart: OnToolExecutionStartCallback;
}

/**
 * `createAuditHook(deps, options?)` — build the R5.5 audit-firing hook.
 *
 * A no-op when `deps.audit` is omitted (Phase 1 allowed, `AgentDeps` docs).
 * Otherwise records `{ userId, jobId, tool, args, ts }` for every tool
 * execution: `userId` from `deps.runtimeContext` (`null` if unauthenticated,
 * R5.1), `jobId` from `options.jobId` (`null` on the synchronous chat path),
 * `tool`/`args` from the SDK's own tool-call event, `ts` from `deps.now()`
 * (never `new Date()`, ADR-3).
 */
export function createAuditHook(deps: AgentDeps, options: CreateAuditHookOptions = {}): AuditHook {
	const jobId = options.jobId ?? null;

	return {
		async onToolExecutionStart(event) {
			if (!deps.audit) return;
			try {
				await deps.audit.record({
					userId: deps.runtimeContext?.userId ?? null,
					jobId,
					tool: event.toolCall.toolName,
					args: event.toolCall.input,
					ts: deps.now(),
				});
			} catch (error) {
				deps.logger.error("audit hook: failed to record tool execution", {
					tool: event.toolCall.toolName,
					jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}
