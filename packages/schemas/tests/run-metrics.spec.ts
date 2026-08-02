import {
	type RunMetrics,
	type RunStopReason,
	runMetricsSchema,
	runStopReasonSchema,
} from "@vaz/schemas/run-metrics";

/**
 * Closed stop-reason vocabulary + run-metrics aggregate (ADR-A/E, Req 1.4/1.5).
 * `deriveStopReason` (packages/agents) produces the enum; nightly/audit/JobEvent
 * consumers rely on this being closed and the token fields being non-negative.
 */

describe("runStopReasonSchema", () => {
	test.each(["natural", "step-cap", "budget-exceeded", "error"] satisfies RunStopReason[])(
		"accepts %s",
		(value) => {
			expect(runStopReasonSchema.safeParse(value).success).toBe(true);
		},
	);

	test("rejects a value outside the closed vocabulary", () => {
		expect(runStopReasonSchema.safeParse("length").success).toBe(false);
	});

	test("rejects a missing value", () => {
		expect(runStopReasonSchema.safeParse(undefined).success).toBe(false);
	});
});

describe("runMetricsSchema", () => {
	const validMetrics: RunMetrics = {
		stopReason: "natural",
		inputTokens: 120,
		outputTokens: 340,
		totalTokens: 460,
		stepCount: 2,
	};

	test("accepts a valid run-metrics object", () => {
		expect(runMetricsSchema.safeParse(validMetrics).success).toBe(true);
	});

	test("accepts zero token counts (e.g. an error before any model call)", () => {
		expect(
			runMetricsSchema.safeParse({
				...validMetrics,
				stopReason: "error",
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			}).success,
		).toBe(true);
	});

	test("rejects a negative token count", () => {
		expect(runMetricsSchema.safeParse({ ...validMetrics, inputTokens: -1 }).success).toBe(false);
	});

	test("rejects a non-integer token count", () => {
		expect(runMetricsSchema.safeParse({ ...validMetrics, outputTokens: 1.5 }).success).toBe(false);
	});

	test("rejects a step count below 1 (a run always takes at least one step)", () => {
		expect(runMetricsSchema.safeParse({ ...validMetrics, stepCount: 0 }).success).toBe(false);
	});

	test("rejects an unrecognized stop reason", () => {
		expect(runMetricsSchema.safeParse({ ...validMetrics, stopReason: "timeout" }).success).toBe(
			false,
		);
	});

	test("rejects a missing stopReason", () => {
		const { stopReason, ...rest } = validMetrics;
		expect(runMetricsSchema.safeParse(rest).success).toBe(false);
	});
});
