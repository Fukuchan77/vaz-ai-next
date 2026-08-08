import type { LanguageModelUsage } from "ai";
import { deriveStopReason } from "../src/stop-reason";

/**
 * `deriveStopReason` (ADR-A, Req 1.4/1.6): out-of-hook pure derivation of the
 * closed run-termination vocabulary from `onEnd`'s `{finishReason, totalUsage,
 * steps}` plus the run's `budget`/`maxSteps`. Fixes the priority order
 * `error` → `budget-exceeded` → `step-cap` → `natural`, and that native
 * `length`/`content-filter`/`tool-calls`/`other` finish reasons all fold into
 * `natural` when no override condition applies.
 */

const BUDGET = 200_000;
const MAX_STEPS = 5;

function usage(
	inputTokens: number,
	outputTokens: number,
): Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> {
	return { inputTokens, outputTokens };
}

function steps(count: number): readonly unknown[] {
	return Array.from({ length: count }, () => ({}));
}

describe("deriveStopReason", () => {
	test("returns natural when the model stops on its own, under budget and step cap", () => {
		expect(
			deriveStopReason({
				finishReason: "stop",
				totalUsage: usage(1_000, 500),
				steps: steps(1),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("natural");
	});

	test.each(["length", "content-filter", "tool-calls", "other"] as const)(
		"folds native finishReason %s into natural",
		(finishReason) => {
			expect(
				deriveStopReason({
					finishReason,
					totalUsage: usage(1_000, 500),
					steps: steps(1),
					budget: BUDGET,
					maxSteps: MAX_STEPS,
				}),
			).toBe("natural");
		},
	);

	test("returns step-cap when steps reach maxSteps, under budget", () => {
		expect(
			deriveStopReason({
				finishReason: "tool-calls",
				totalUsage: usage(1_000, 500),
				steps: steps(MAX_STEPS),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("step-cap");
	});

	test("returns natural when steps are one below maxSteps (boundary)", () => {
		expect(
			deriveStopReason({
				finishReason: "tool-calls",
				totalUsage: usage(1_000, 500),
				steps: steps(MAX_STEPS - 1),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("natural");
	});

	test("returns budget-exceeded when input+output tokens reach the budget, under step cap", () => {
		expect(
			deriveStopReason({
				finishReason: "stop",
				totalUsage: usage(BUDGET, 0),
				steps: steps(1),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("budget-exceeded");
	});

	test("returns natural when tokens are one below the budget (boundary)", () => {
		expect(
			deriveStopReason({
				finishReason: "stop",
				totalUsage: usage(BUDGET - 1, 0),
				steps: steps(1),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("natural");
	});

	test("treats undefined token counts as zero, not budget-exceeded", () => {
		expect(
			deriveStopReason({
				finishReason: "stop",
				totalUsage: { inputTokens: undefined, outputTokens: undefined },
				steps: steps(1),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("natural");
	});

	test("returns error when finishReason is error, regardless of budget or step cap", () => {
		expect(
			deriveStopReason({
				finishReason: "error",
				totalUsage: usage(1_000, 500),
				steps: steps(1),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("error");
	});

	test("prioritizes budget-exceeded over step-cap when both conditions hold", () => {
		expect(
			deriveStopReason({
				finishReason: "tool-calls",
				totalUsage: usage(BUDGET, 0),
				steps: steps(MAX_STEPS),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("budget-exceeded");
	});

	test("prioritizes error over budget-exceeded and step-cap when all conditions hold", () => {
		expect(
			deriveStopReason({
				finishReason: "error",
				totalUsage: usage(BUDGET, 0),
				steps: steps(MAX_STEPS),
				budget: BUDGET,
				maxSteps: MAX_STEPS,
			}),
		).toBe("error");
	});
});
