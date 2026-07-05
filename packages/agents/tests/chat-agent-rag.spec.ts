import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import type { EmbedQuery, RetrievalMatch, RetrievalStore } from "@vaz/rag/retrieve/index";
import { createRetrievalCapability } from "@vaz/rag/tools";
import type { AgentDeps } from "@vaz/schemas/deps";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { buildChatTools, createChatAgent } from "../src/chat-agent";

/**
 * RAG retrieval registration in `createChatAgent` (R2.4) and its
 * backward-compatibility guarantee (R1.7): the `searchDocuments` tool is
 * registered only when a datastore is available — Phase 1 (`db: null`) keeps
 * exactly the Phase 1 tool set. Network/DB-free via the `model` seam
 * (`MockLanguageModelV4`) and the retrieval store/embedder seams.
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

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";

const fakeEmbedQuery: EmbedQuery = async () => new Array<number>(EMBEDDING_DIM).fill(0);
class FakeStore implements RetrievalStore {
	matches: RetrievalMatch[] = [];
	async searchByVector() {
		return this.matches;
	}
}
const fakeRetrieval = (matches: RetrievalMatch[] = []) => {
	const store = new FakeStore();
	store.matches = matches;
	return createRetrievalCapability(makeDeps(), { store, embedQuery: fakeEmbedQuery });
};

describe("buildChatTools — RAG registration decision", () => {
	test("registers only the time tool with no datastore (db: null → R1.7 unchanged)", () => {
		expect(Object.keys(buildChatTools(makeDeps())).sort()).toEqual(["getCurrentTime"]);
	});

	test("registers searchDocuments when a datastore is present (deps-driven)", () => {
		const deps = { db: {}, logger: silentLogger, now: () => new Date() } as unknown as AgentDeps;
		expect(Object.keys(buildChatTools(deps)).sort()).toEqual(["getCurrentTime", "searchDocuments"]);
	});

	test("registers an injected retrieval capability (test seam)", () => {
		const tools = buildChatTools(makeDeps(), { retrieval: fakeRetrieval() });
		expect(Object.keys(tools)).toContain("searchDocuments");
	});
});

describe("createChatAgent — RAG tool execution (R2.4)", () => {
	test("routes a searchDocuments call to the capability and returns chunks + citations", async () => {
		const retrieval = fakeRetrieval([
			{
				chunkId: CHUNK_ID,
				documentId: DOC_ID,
				source: "docs/onboarding.md",
				ordinal: 0,
				content: "New hires finish security training in week one.",
				distance: 0.1,
			},
		]);

		const model = new MockLanguageModelV4({
			doStream: [
				{
					stream: simulateReadableStream({
						chunks: [
							{
								type: "tool-call",
								toolCallId: "call-1",
								toolName: "searchDocuments",
								input: JSON.stringify({ query: "onboarding security training" }),
							},
							{
								type: "finish",
								finishReason: { unified: "tool-calls", raw: undefined },
								usage: USAGE,
							},
						],
					}),
				},
				{
					stream: simulateReadableStream({
						chunks: [
							{ type: "text-start", id: "t1" },
							{ type: "text-delta", id: "t1", delta: "オンボーディング資料によると…" },
							{ type: "text-end", id: "t1" },
							{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
						],
					}),
				},
			],
		});

		const agent = createChatAgent(makeDeps(), { model, retrieval });
		const result = await agent.stream({ messages: userMessage("入社時の手続きは？") });

		const toolCalls = await result.toolCalls;
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.toolName).toBe("searchDocuments");

		const toolResults = await result.toolResults;
		expect(toolResults).toHaveLength(1);
		const output = toolResults[0]?.output as {
			chunks: Array<{ chunkId: string }>;
			citations: Array<{ documentId: string; source: string; chunkId: string }>;
		};
		expect(output.chunks).toHaveLength(1);
		expect(output.chunks[0].chunkId).toBe(CHUNK_ID);
		// 1:1 citations projected from the chunks (9.1 `toCitation`)
		expect(output.citations).toEqual([
			{ documentId: DOC_ID, source: "docs/onboarding.md", chunkId: CHUNK_ID },
		]);

		expect(model.doStreamCalls).toHaveLength(2);
		expect(await result.text).toBe("オンボーディング資料によると…");
	});
});
