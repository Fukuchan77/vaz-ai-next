import { type GoldenCase, resolveCostCapFromEnv, runNightlyEval } from "@vaz/evals/nightly";
import type { AgentDeps } from "@vaz/schemas/deps";
import type { GradeReport } from "@vaz/schemas/eval";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Tier3 nightly harness (R4.4/4.6): `runNightlyEval` drives the real chat
 * agent (`createChatAgent`, no override in production) against a golden set,
 * grades each completed run with the tier3 judge (`gradeRun`, Task 17.3), and
 * enforces a token-based cost cap. These specs inject `MockLanguageModelV4`
 * for both the agent and the judge (the same `options.model` test seam as
 * `chat-agent.spec.ts` / `judge.spec.ts`, ADR-3/R1.6) — no network.
 */

const AGENT_USAGE = {
	inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 50, text: 50, reasoning: undefined },
};

function agentModelWithText(text: string) {
	return new MockLanguageModelV4({
		// A function (not a fixed array) so every case's `agent.stream()` call gets
		// a fresh stream — a golden set with more than one case calls `doStream`
		// more than once on this same model instance.
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: [
					{ type: "text-start", id: "t1" },
					{ type: "text-delta", id: "t1", delta: text },
					{ type: "text-end", id: "t1" },
					{
						type: "finish",
						finishReason: { unified: "stop", raw: undefined },
						usage: AGENT_USAGE,
					},
				],
			}),
		}),
	});
}

function judgeModelReturning(report: GradeReport) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: "text" as const, text: JSON.stringify(report) }],
			finishReason: { unified: "stop" as const, raw: undefined },
			usage: AGENT_USAGE,
			warnings: [],
		}),
	});
}

function makeDeps(): AgentDeps {
	return {
		db: null,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		now: () => new Date("2026-01-02T03:04:05Z"),
	};
}

const PASSING_CASE: GoldenCase = {
	id: "greeting",
	request: "こんにちは",
	minOutcomeScore: 0.5,
	minBehaviorScore: 0.5,
};

const HIGH_REPORT: GradeReport = {
	outcome: { score: 0.9, rationale: "Answers the brief." },
	behavior: { score: 0.9, rationale: "Reasonable process." },
};

const LOW_REPORT: GradeReport = {
	outcome: { score: 0.1, rationale: "Misses the brief." },
	behavior: { score: 0.2, rationale: "Skipped a needed step." },
};

describe("runNightlyEval (tier3 nightly harness, R4.4/4.6)", () => {
	test("grades each golden case and reports no regression when scores meet the baseline", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		expect(summary.results).toHaveLength(1);
		const [result] = summary.results;
		expect(result?.skipped).toBe(false);
		if (result && !result.skipped) {
			expect(result.grade).toEqual(HIGH_REPORT);
			expect(result.regressed).toBe(false);
		}
		expect(summary.hasRegression).toBe(false);
		expect(summary.totalTokens).toBeGreaterThan(0);
		expect(summary.costCapExceeded).toBe(false);
	});

	test("flags a case as regressed when the judge score falls below the golden case's baseline", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel: judgeModelReturning(LOW_REPORT),
		});

		const [result] = summary.results;
		expect(result?.skipped).toBe(false);
		if (result && !result.skipped) {
			expect(result.regressed).toBe(true);
		}
		expect(summary.hasRegression).toBe(true);
	});

	test("skips remaining cases once cumulative usage reaches the cost cap (R4.6)", async () => {
		const secondCase: GoldenCase = {
			id: "second",
			request: "調子はどう？",
			minOutcomeScore: 0.5,
			minBehaviorScore: 0.5,
		};
		const judgeModel = judgeModelReturning(HIGH_REPORT);

		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE, secondCase],
			// The first case's usage — agent (100 input + 50 output = 150) PLUS the
			// judge's own generateText call (same AGENT_USAGE = 150) = 300 tokens —
			// alone reaches this cap, so the second case must be skipped rather than run.
			costCapTokens: 150,
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel,
		});

		expect(summary.results).toHaveLength(2);
		const [first, second] = summary.results;
		expect(first?.skipped).toBe(false);
		expect(second).toMatchObject({ id: "second", skipped: true, reason: "cost-cap-exceeded" });
		expect(summary.costCapExceeded).toBe(true);
		// Only the first case's judge call ran; the skipped case never reached gradeRun.
		expect(judgeModel.doGenerateCalls).toHaveLength(1);
	});

	test("counts the judge model's own token usage toward totalTokens, not just the agent's", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		// Agent usage (150) + judge usage (150, same AGENT_USAGE shape) — if the judge's
		// spend were silently dropped, this would be 150, not 300.
		expect(summary.totalTokens).toBe(300);
	});

	test("reports allSkipped and does not silently pass when the cost cap is exhausted before any case runs", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			costCapTokens: 0,
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		expect(summary.results).toEqual([
			{ id: "greeting", request: "こんにちは", skipped: true, reason: "cost-cap-exceeded" },
		]);
		expect(summary.allSkipped).toBe(true);
		expect(summary.hasRegression).toBe(false);
	});

	test("captures a case that throws as case-failed, flags hasFailure, and still runs the next case", async () => {
		// Throws only on the first `doStream` call (the "greeting" case); the
		// second case's call gets a normal stream, proving the loop recovered.
		let doStreamCallCount = 0;
		const throwOnceThenSucceedModel = new MockLanguageModelV4({
			doStream: async () => {
				doStreamCallCount += 1;
				if (doStreamCallCount === 1) {
					throw new Error("provider 503");
				}
				return {
					stream: simulateReadableStream({
						chunks: [
							{ type: "text-start", id: "t1" },
							{ type: "text-delta", id: "t1", delta: "元気です" },
							{ type: "text-end", id: "t1" },
							{
								type: "finish",
								finishReason: { unified: "stop", raw: undefined },
								usage: AGENT_USAGE,
							},
						],
					}),
				};
			},
		});
		const secondCase: GoldenCase = {
			id: "second",
			request: "調子はどう？",
			minOutcomeScore: 0.5,
			minBehaviorScore: 0.5,
		};

		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE, secondCase],
			agentModel: throwOnceThenSucceedModel,
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		expect(summary.results).toHaveLength(2);
		const [first, second] = summary.results;
		expect(first).toMatchObject({ id: "greeting", skipped: true, reason: "case-failed" });
		// The underlying "provider 503" is wrapped by the AI SDK's stream-error handling
		// before it reaches this catch block; assert a non-empty message was captured
		// rather than pinning to that wrapping's exact internal text.
		expect((first as { error?: string }).error).toBeTruthy();
		// The failed first case never reached gradeRun, so it contributed no tokens —
		// the second case still gets a chance to run rather than the run aborting outright.
		expect(second?.skipped).toBe(false);
		expect(summary.hasFailure).toBe(true);
		expect(summary.allSkipped).toBe(false);
	});

	test("defaults to the built-in golden set and default cost cap when omitted", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			agentModel: agentModelWithText("了解です"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		expect(summary.results.length).toBeGreaterThan(0);
		expect(summary.costCapTokens).toBeGreaterThan(0);
	});
});

describe("resolveCostCapFromEnv (R4.6 — a misconfigured cap must not silently disable the run)", () => {
	test("returns undefined when the env var is unset or empty", () => {
		expect(resolveCostCapFromEnv({})).toBeUndefined();
		expect(resolveCostCapFromEnv({ EVAL_NIGHTLY_COST_CAP_TOKENS: "" })).toBeUndefined();
	});

	test("returns undefined for a non-numeric value", () => {
		expect(resolveCostCapFromEnv({ EVAL_NIGHTLY_COST_CAP_TOKENS: "not-a-number" })).toBeUndefined();
	});

	test("returns undefined for zero — a zero cap would skip every case before it runs", () => {
		expect(resolveCostCapFromEnv({ EVAL_NIGHTLY_COST_CAP_TOKENS: "0" })).toBeUndefined();
	});

	test("returns undefined for a negative value", () => {
		expect(resolveCostCapFromEnv({ EVAL_NIGHTLY_COST_CAP_TOKENS: "-5" })).toBeUndefined();
	});

	test("returns the parsed value for a valid positive integer", () => {
		expect(resolveCostCapFromEnv({ EVAL_NIGHTLY_COST_CAP_TOKENS: "10000" })).toBe(10000);
	});
});
