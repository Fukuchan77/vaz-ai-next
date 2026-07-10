import { buildJudgePrompt, gradeRun } from "@vaz/evals/judge";
import type { GradeReport } from "@vaz/schemas/eval";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Tier3 LLM-as-judge (R4.4/4.5): `gradeRun` grades a completed agent run
 * against the `GradeReport` contract (`@vaz/schemas/eval`). These specs
 * exercise the grading wiring itself (prompt construction, schema
 * validation) with an injected `MockLanguageModelV4` — no network — the same
 * test seam `createChatAgent` uses (ADR-3/R1.6). The nightly harness (Task
 * 17.4) is what actually points this at a real model.
 */

const USAGE = {
	inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 20, text: 20, reasoning: undefined },
};

const validReport: GradeReport = {
	outcome: { score: 0.9, rationale: "The final document answers the brief." },
	behavior: { score: 0.6, rationale: "Skipped the citation-check tool before answering." },
};

function modelReturning(text: string) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: USAGE,
			warnings: [],
		}),
	});
}

describe("gradeRun (tier3 LLM-as-judge, R4.4/4.5)", () => {
	test("returns a schema-valid GradeReport parsed from the model's output", async () => {
		const model = modelReturning(JSON.stringify(validReport));

		const report = await gradeRun(
			{
				request: "オンボーディング資料の要点をまとめて",
				toolCalls: [{ toolName: "searchDocuments", input: { query: "onboarding" } }],
				finalOutput: "オンボーディング資料によると、初週にセキュリティ研修を行います。",
			},
			{ model },
		);

		expect(report).toEqual(validReport);
	});

	test("keeps outcome and behavior independently scored (R4.5)", async () => {
		const model = modelReturning(JSON.stringify(validReport));

		const report = await gradeRun(
			{ request: "何か調べて", toolCalls: [], finalOutput: "調べました" },
			{ model },
		);

		expect(report.outcome.score).toBe(0.9);
		expect(report.behavior.score).toBe(0.6);
	});

	test("rejects when the model's output fails the GradeReport schema (missing behavior axis)", async () => {
		const model = modelReturning(JSON.stringify({ outcome: validReport.outcome }));

		await expect(
			gradeRun({ request: "何か調べて", toolCalls: [], finalOutput: "調べました" }, { model }),
		).rejects.toThrow();
	});
});

describe("buildJudgePrompt", () => {
	test("includes the request, the ordered tool-call trace, and the final output", () => {
		const prompt = buildJudgePrompt({
			request: "今何時か教えて",
			toolCalls: [{ toolName: "getCurrentTime", input: { timeZone: "Asia/Tokyo" } }],
			finalOutput: "現在時刻は10時です",
		});

		expect(prompt).toContain("今何時か教えて");
		expect(prompt).toContain("getCurrentTime");
		expect(prompt).toContain('{"timeZone":"Asia/Tokyo"}');
		expect(prompt).toContain("現在時刻は10時です");
	});

	test("renders a run with no tool calls without crashing", () => {
		const prompt = buildJudgePrompt({
			request: "こんにちは",
			toolCalls: [],
			finalOutput: "こんにちは！",
		});

		expect(prompt).toContain("こんにちは");
		expect(prompt).toContain("(no tool calls)");
	});
});
