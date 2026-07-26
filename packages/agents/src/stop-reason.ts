import type { RunStopReason } from "@vaz/schemas/run-metrics";
import type { FinishReason, LanguageModelUsage } from "ai";

/** Input to {@link deriveStopReason} — `onEnd`'s `{finishReason, totalUsage, steps}` plus the run's budget/step-cap thresholds. */
export interface DeriveStopReasonInput {
	finishReason: FinishReason;
	totalUsage: Pick<LanguageModelUsage, "inputTokens" | "outputTokens">;
	steps: readonly unknown[];
	budget: number;
	maxSteps: number;
}

/**
 * Out-of-hook pure derivation of the closed `RunStopReason` vocabulary
 * (ADR-A, Req 1.4): AI SDK v7's `stopWhen` array can't distinguish "hit the
 * step cap" from "hit the token budget" via `finishReason` alone, so this
 * reconstructs it from the same signals `onEnd` already has. Priority order
 * `error` → `budget-exceeded` → `step-cap` → `natural` — see
 * `runStopReasonSchema`'s doc comment for the full rationale.
 */
export function deriveStopReason({
	finishReason,
	totalUsage,
	steps,
	budget,
	maxSteps,
}: DeriveStopReasonInput): RunStopReason {
	if (finishReason === "error") return "error";

	const consumedTokens = (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0);
	if (consumedTokens >= budget) return "budget-exceeded";

	if (steps.length >= maxSteps) return "step-cap";

	return "natural";
}
