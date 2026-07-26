import { buildChatTools, createChatAgent } from "@vaz/agents/chat-agent";
import { EMBEDDING_DIM } from "@vaz/db/schema";
import type { EmbedQuery, RetrievalMatch, RetrievalStore } from "@vaz/rag/retrieve/index";
import { createRetrievalCapability } from "@vaz/rag/tools";
import type { AgentDeps } from "@vaz/schemas/deps";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Tier1 unit eval (R4.4): tool selection + loop control, driven by
 * `MockLanguageModelV4` (`ai/test`, no network/real LLM — runs every CI). This
 * is the `@vaz/evals` golden set that exercises `createChatAgent` (`@vaz/agents`)
 * with BOTH registered tools present (`getCurrentTime` + the injected RAG
 * `searchDocuments`), so "selection" actually discriminates between candidates
 * rather than trivially calling the only tool available.
 *
 * Loop control locks the `isStepCount(5)` cap (R1.7 migration-equivalence
 * value in `chat-agent.ts`'s private `MAX_STEPS`) — a cross-cutting behavior
 * `packages/agents/tests/**` never exercises at the cap boundary.
 */

const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const makeDeps = (): AgentDeps => ({ db: null, logger: silentLogger, now: () => new Date() });
const userMessage = (text: string) => [
	{ id: "m1", role: "user" as const, parts: [{ type: "text" as const, text }] },
];

const fakeEmbedQuery: EmbedQuery = async () => new Array<number>(EMBEDDING_DIM).fill(0);

class FakeStore implements RetrievalStore {
	matches: RetrievalMatch[] = [];
	async searchByVector() {
		return this.matches;
	}
}

/** Both tools registered (getCurrentTime always + injected RAG retrieval). */
function makeAgent(model: MockLanguageModelV4) {
	const store = new FakeStore();
	store.matches = [
		{
			chunkId: "22222222-2222-4222-8222-222222222222",
			documentId: "11111111-1111-4111-8111-111111111111",
			source: "docs/onboarding.md",
			ordinal: 0,
			content: "New hires finish security training in week one.",
			distance: 0.1,
		},
	];
	const retrieval = createRetrievalCapability(makeDeps(), { store, embedQuery: fakeEmbedQuery });
	return createChatAgent(makeDeps(), { model, retrieval });
}

/** A model turn that calls `toolName` with `input`, then stops the step. */
function toolCallTurn(toolCallId: string, toolName: string, input: unknown) {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) },
				{
					type: "finish" as const,
					finishReason: { unified: "tool-calls", raw: undefined },
					usage: USAGE,
				},
			],
		}),
	};
}

/** A model turn that produces the final text answer and stops the loop. */
function textTurn(id: string, text: string) {
	return {
		stream: simulateReadableStream({
			chunks: [
				{ type: "text-start" as const, id },
				{ type: "text-delta" as const, id, delta: text },
				{ type: "text-end" as const, id },
				{
					type: "finish" as const,
					finishReason: { unified: "stop", raw: undefined },
					usage: USAGE,
				},
			],
		}),
	};
}

describe("tier1 golden set — tool selection (R4.4)", () => {
	test("a time query routes to getCurrentTime, not searchDocuments", async () => {
		const model = new MockLanguageModelV4({
			doStream: [
				toolCallTurn("call-1", "getCurrentTime", { timeZone: "Asia/Tokyo" }),
				textTurn("t1", "只今の時刻をお伝えしました"),
			],
		});

		const result = await makeAgent(model).stream({ messages: userMessage("今何時？") });
		const toolCalls = await result.toolCalls;

		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.toolName).toBe("getCurrentTime");
	});

	test("a document query routes to searchDocuments, not getCurrentTime", async () => {
		const model = new MockLanguageModelV4({
			doStream: [
				toolCallTurn("call-1", "searchDocuments", { query: "onboarding security training" }),
				textTurn("t1", "オンボーディング資料によると…"),
			],
		});

		const result = await makeAgent(model).stream({ messages: userMessage("入社時の手続きは？") });
		const toolCalls = await result.toolCalls;

		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.toolName).toBe("searchDocuments");
	});

	test("both tools are registered together (selection has real candidates)", () => {
		const store = new FakeStore();
		const retrieval = createRetrievalCapability(makeDeps(), { store, embedQuery: fakeEmbedQuery });
		expect(Object.keys(buildChatTools(makeDeps(), { retrieval })).sort()).toEqual([
			"getCurrentTime",
			"searchDocuments",
		]);
	});
});

describe("tier1 golden set — loop control at the isStepCount(5) cap (R1.7/R4.4)", () => {
	test("stops after exactly 5 model turns even when every turn keeps calling a tool", async () => {
		// 6 identical tool-call turns scripted, one more than the cap: if the loop
		// stopped merely because the mock ran out of turns, doStreamCalls would be
		// 6, not 5. Getting exactly 5 proves isStepCount(5) — not mock exhaustion —
		// ended the loop.
		const model = new MockLanguageModelV4({
			doStream: Array.from({ length: 6 }, (_, i) =>
				toolCallTurn(`call-${i}`, "getCurrentTime", { timeZone: "Asia/Tokyo" }),
			),
		});

		const result = await makeAgent(model).stream({ messages: userMessage("今何時？") });
		const toolCalls = await result.toolCalls;

		expect(model.doStreamCalls).toHaveLength(5);
		expect(toolCalls).toHaveLength(5);
	});
});
