import { z } from "zod";

/**
 * Closed run-termination vocabulary (ADR-A, Req 1.4).
 *
 * AI SDK v7's `finishReason` does not surface a distinct value when a run
 * stops because of the cumulative token-budget predicate (it just reports the
 * final step's model-native reason, e.g. `"stop"`) — so `stop_reason` cannot
 * be read off `finishReason` directly. `@vaz/agents#deriveStopReason` derives
 * this closed enum out-of-hook from `{ finishReason, totalUsage, steps,
 * budget, maxSteps }`, in priority order `error` → `budget-exceeded` →
 * `step-cap` → `natural` (native `"length"`/`"content-filter"`/`"other"` fold
 * into `natural`; the raw `finishReason` is recorded separately as a
 * telemetry attribute for anyone who needs the unfolded detail).
 */
export const runStopReasonSchema = z.enum(["natural", "step-cap", "budget-exceeded", "error"]);

export type RunStopReason = z.infer<typeof runStopReasonSchema>;

/**
 * Aggregate metrics for one completed chat/supervisor run (ADR-D/E, Req
 * 1.4/1.5). Token fields mirror the v7 `usage` shape (`inputTokens`/
 * `outputTokens`/`totalTokens` — the v6 `promptTokens`/`completionTokens`
 * names were retired) and are the run's cumulative `totalUsage`, not a single
 * step's. This shape is consumed both by `deps.audit.recordRun` (ADR-D, no
 * raw prompts/tool args — R4.7) and by `JobEvent`'s `completion.metrics`
 * (ADR-E, optional field kept SSE wire-backward-compatible).
 */
export const runMetricsSchema = z.object({
	stopReason: runStopReasonSchema,
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	totalTokens: z.number().int().nonnegative(),
	stepCount: z.number().int().positive(),
});

export type RunMetrics = z.infer<typeof runMetricsSchema>;
