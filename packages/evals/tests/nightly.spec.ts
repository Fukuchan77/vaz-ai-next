import {
	GOLDEN_SET,
	type GoldenCase,
	resolveCostCapFromEnv,
	runNightlyEval,
} from "@vaz/evals/nightly";
import type { AgentDeps } from "@vaz/schemas/deps";
import type { GradeReport } from "@vaz/schemas/eval";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Tier3 nightly harness (R4.4/4.6): `runNightlyEval` drives the real chat
 * agent (`createChatAgent`, no override in production) against a golden set,
 * grades each completed run with the tier3 judge (`gradeRun`), and
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

/** A two-turn model: calls `getCurrentTime` first, then answers using the real result (Req 5.2 tier2). */
function agentModelWithToolCall(finalText: string) {
	return new MockLanguageModelV4({
		doStream: [
			{
				stream: simulateReadableStream({
					chunks: [
						{ type: "tool-call", toolCallId: "call-1", toolName: "getCurrentTime", input: "{}" },
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: undefined },
							usage: AGENT_USAGE,
						},
					],
				}),
			},
			{
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "t2" },
						{ type: "text-delta", id: "t2", delta: finalText },
						{ type: "text-end", id: "t2" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: AGENT_USAGE,
						},
					],
				}),
			},
		],
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

		// Exactly one result per case in the default GOLDEN_SET (whether graded or
		// skipped) — `pr-gate.ts#runPrGate` relies on this contract to derive
		// `goldenSetSize`/the report-only floor (Req 5.4) from `results.length`
		// without threading `GOLDEN_SET` itself through `computePrGateMetrics`.
		expect(summary.results).toHaveLength(GOLDEN_SET.length);
		expect(summary.costCapTokens).toBeGreaterThan(0);
	});
});

describe("runNightlyEval tier2 wiring (Req 5.2)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function tier2Response(score: number, verdict: boolean) {
		return new Response(
			JSON.stringify({
				score,
				verdict,
				judge_model: "claude-opus-4-8",
				usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
			}),
			{ status: 200 },
		);
	}

	test("omits tier2 entirely when tier2BaseUrl is not configured (default, byte-equivalent)", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		const [result] = summary.results;
		expect(result?.skipped).toBe(false);
		if (result && !result.skipped) {
			expect(result.tier2).toBeUndefined();
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("skips tier2 for a case with no tool calls (nothing to ground faithfulness/relevancy in)", async () => {
		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			tier2BaseUrl: "http://localhost:8000",
			agentModel: agentModelWithText("こんにちは！"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		const [result] = summary.results;
		expect(result?.skipped).toBe(false);
		if (result && !result.skipped) {
			expect(result.tier2).toEqual({ skipped: true, reason: "no-context" });
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("calls /eval/faithfulness and /eval/relevancy when the run produced tool-result context", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("/eval/faithfulness") ? tier2Response(0.8, true) : tier2Response(0.7, true),
		);

		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			tier2BaseUrl: "http://localhost:8000",
			agentModel: agentModelWithToolCall("午前3時です"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		const [result] = summary.results;
		expect(result?.skipped).toBe(false);
		if (result && !result.skipped) {
			expect(result.tier2).toEqual({
				skipped: false,
				faithfulness: { score: 0.8, verdict: true, totalTokens: 30 },
				relevancy: { score: 0.7, verdict: true, totalTokens: 30 },
			});
			// Agent (2 steps × 150 = 300) + judge (150) + tier2 (30 + 30) = 510 —
			// tier2 spend must count toward the same cost cap, not be a free side
			// effect (Req 5.2).
			expect(result.totalTokens).toBe(510);
		}
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("records tier2 as request-failed (not case-failed) when services/agent is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

		const summary = await runNightlyEval({
			deps: makeDeps(),
			goldenSet: [PASSING_CASE],
			tier2BaseUrl: "http://localhost:8000",
			agentModel: agentModelWithToolCall("午前3時です"),
			judgeModel: judgeModelReturning(HIGH_REPORT),
		});

		const [result] = summary.results;
		// The case itself still graded successfully — only the additive tier2
		// enrichment failed.
		expect(result?.skipped).toBe(false);
		if (result && !result.skipped) {
			expect(result.tier2).toMatchObject({ skipped: true, reason: "request-failed" });
		}
		expect(summary.hasFailure).toBe(false);
	});
});

describe("GOLDEN_SET (Req 5.1 — expanded to real-conversation-derived cases)", () => {
	test("has at least 20 cases", () => {
		expect(GOLDEN_SET.length).toBeGreaterThanOrEqual(20);
	});

	test("has unique, non-empty ids", () => {
		const ids = GOLDEN_SET.map((goldenCase) => goldenCase.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id.length).toBeGreaterThan(0);
		}
	});

	test("every case has a non-empty request and score baselines within [0, 1]", () => {
		for (const goldenCase of GOLDEN_SET) {
			expect(goldenCase.request.length).toBeGreaterThan(0);
			expect(goldenCase.minOutcomeScore).toBeGreaterThanOrEqual(0);
			expect(goldenCase.minOutcomeScore).toBeLessThanOrEqual(1);
			expect(goldenCase.minBehaviorScore).toBeGreaterThanOrEqual(0);
			expect(goldenCase.minBehaviorScore).toBeLessThanOrEqual(1);
		}
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
