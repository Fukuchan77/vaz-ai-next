import { deriveTier2Contexts, resolveTier2BaseUrlFromEnv, runTier2Case } from "@vaz/evals/tier2";
import type { EvalResponse } from "@vaz/schemas/agent-service";

/**
 * Tier2 faithfulness/relevancy client (Req 5.2). `runTier2Case`'s own HTTP
 * behavior is exercised with a stubbed global `fetch` (house convention,
 * `packages/rag/tests/via-parser.spec.ts#createAgentServiceParser`) — no
 * network, no `services/agent` process required.
 */

function evalResponse(overrides: Partial<EvalResponse> = {}): EvalResponse {
	return {
		score: 0.9,
		verdict: true,
		judge_model: "claude-opus-4-8",
		usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		...overrides,
	};
}

describe("runTier2Case (Req 5.2)", () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test("posts {question,contexts,answer} to both endpoints and maps score/verdict/tokens per axis", async () => {
		fetchMock.mockImplementation(async (url: string) => {
			if (url.endsWith("/eval/faithfulness")) {
				return new Response(JSON.stringify(evalResponse({ score: 0.8 })), { status: 200 });
			}
			return new Response(JSON.stringify(evalResponse({ score: 0.6, verdict: false })), {
				status: 200,
			});
		});

		const result = await runTier2Case("http://localhost:8000", {
			question: "今何時?",
			contexts: ["2026-01-02T03:04:05Z"],
			answer: "午前3時です",
		});

		expect(result).toEqual({
			skipped: false,
			faithfulness: { score: 0.8, verdict: true, totalTokens: 15 },
			relevancy: { score: 0.6, verdict: false, totalTokens: 15 },
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		const faithfulnessCall = fetchMock.mock.calls.find(([url]: [string]) =>
			url.endsWith("/eval/faithfulness"),
		);
		expect(faithfulnessCall?.[0]).toBe("http://localhost:8000/eval/faithfulness");
		expect(faithfulnessCall?.[1]?.method).toBe("POST");
		expect(JSON.parse(faithfulnessCall?.[1]?.body as string)).toEqual({
			question: "今何時?",
			contexts: ["2026-01-02T03:04:05Z"],
			answer: "午前3時です",
		});
	});

	test("reports request-failed (never throws) when the service is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await runTier2Case("http://localhost:8000", {
			question: "q",
			contexts: ["c"],
			answer: "a",
		});

		expect(result).toMatchObject({ skipped: true, reason: "request-failed" });
		expect((result as { error?: string }).error).toMatch(/ECONNREFUSED/);
	});

	test("reports request-failed on a non-2xx response", async () => {
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));

		const result = await runTier2Case("http://localhost:8000", {
			question: "q",
			contexts: ["c"],
			answer: "a",
		});

		expect(result).toMatchObject({ skipped: true, reason: "request-failed" });
	});

	test("reports request-failed when the response fails schema validation", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ score: 2 }), { status: 200 }));

		const result = await runTier2Case("http://localhost:8000", {
			question: "q",
			contexts: ["c"],
			answer: "a",
		});

		expect(result).toMatchObject({ skipped: true, reason: "request-failed" });
	});
});

describe("deriveTier2Contexts (Req 5.2)", () => {
	test("returns undefined when the run made no tool calls (nothing to ground faithfulness in)", () => {
		expect(deriveTier2Contexts([])).toBeUndefined();
	});

	test("stringifies each tool result (name + output) as a context entry", () => {
		const contexts = deriveTier2Contexts([
			{ toolName: "getCurrentTime", output: { timeZone: "UTC", now: "2026-01-02" } },
		]);

		expect(contexts).toHaveLength(1);
		expect(contexts?.[0]).toContain("getCurrentTime");
		expect(contexts?.[0]).toContain("2026-01-02");
	});
});

describe("resolveTier2BaseUrlFromEnv (Req 5.2 — unset/blank means skip, never throw)", () => {
	test("returns undefined when AGENT_SERVICE_URL is unset", () => {
		expect(resolveTier2BaseUrlFromEnv({})).toBeUndefined();
	});

	test("returns undefined for a blank value", () => {
		expect(resolveTier2BaseUrlFromEnv({ AGENT_SERVICE_URL: "   " })).toBeUndefined();
	});

	test("returns the trimmed url when set", () => {
		expect(resolveTier2BaseUrlFromEnv({ AGENT_SERVICE_URL: " http://localhost:8000 " })).toBe(
			"http://localhost:8000",
		);
	});
});
