import {
	type GradeAxis,
	type GradeReport,
	gradeAxisSchema,
	gradeReportSchema,
} from "@vaz/schemas/eval";

/**
 * LLM-as-judge grading contract (R4.5): outcome (final artifact) and behavior
 * (process) are scored on separate axes and packaged into a typed
 * `GradeReport` — see `packages/schemas/src/eval.ts` for the design rationale.
 */

describe("gradeAxisSchema", () => {
	test("accepts a score in [0, 1] with a non-empty rationale", () => {
		const axis: GradeAxis = { score: 0.75, rationale: "Cited every claim correctly." };
		expect(gradeAxisSchema.safeParse(axis).success).toBe(true);
	});

	test("accepts the boundary scores 0 and 1", () => {
		expect(gradeAxisSchema.safeParse({ score: 0, rationale: "r" }).success).toBe(true);
		expect(gradeAxisSchema.safeParse({ score: 1, rationale: "r" }).success).toBe(true);
	});

	test("rejects a score below 0", () => {
		expect(gradeAxisSchema.safeParse({ score: -0.1, rationale: "r" }).success).toBe(false);
	});

	test("rejects a score above 1", () => {
		expect(gradeAxisSchema.safeParse({ score: 1.1, rationale: "r" }).success).toBe(false);
	});

	test("rejects an empty rationale (judge output must be auditable)", () => {
		expect(gradeAxisSchema.safeParse({ score: 0.5, rationale: "" }).success).toBe(false);
	});

	test("rejects a missing rationale", () => {
		expect(gradeAxisSchema.safeParse({ score: 0.5 }).success).toBe(false);
	});
});

describe("gradeReportSchema (R4.5: outcome/behavior on separate axes)", () => {
	const validReport: GradeReport = {
		outcome: { score: 0.9, rationale: "The final document answers the brief." },
		behavior: { score: 0.6, rationale: "Skipped the citation-check tool before answering." },
	};

	test("accepts a report with both outcome and behavior axes", () => {
		expect(gradeReportSchema.safeParse(validReport).success).toBe(true);
	});

	test("keeps outcome and behavior independently scored (a low behavior score does not require a low outcome score)", () => {
		const parsed = gradeReportSchema.safeParse(validReport);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.outcome.score).toBe(0.9);
			expect(parsed.data.behavior.score).toBe(0.6);
		}
	});

	test("rejects a report missing the behavior axis", () => {
		expect(gradeReportSchema.safeParse({ outcome: validReport.outcome }).success).toBe(false);
	});

	test("rejects a report missing the outcome axis", () => {
		expect(gradeReportSchema.safeParse({ behavior: validReport.behavior }).success).toBe(false);
	});

	test("rejects a report whose outcome axis is malformed", () => {
		expect(
			gradeReportSchema.safeParse({
				outcome: { score: 2, rationale: "r" },
				behavior: validReport.behavior,
			}).success,
		).toBe(false);
	});
});
