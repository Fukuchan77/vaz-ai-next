import { createChatAgent } from "@vaz/agents/chat-agent";
import { EMBEDDING_DIM } from "@vaz/db/schema";
import type { EmbedQuery, RetrievalMatch, RetrievalStore } from "@vaz/rag/retrieve/index";
import { createRetrievalCapability } from "@vaz/rag/tools";
import type { AgentDeps } from "@vaz/schemas/deps";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Tier1 unit eval (R4.4): schema conformance. A tool call whose `input` fails
 * its Zod `inputSchema` (type mismatch, or a `.max()`/`.min()` constraint
 * violation) must surface as a `tool-error` content part — and, crucially,
 * must NOT reach the tool's `execute()` — rather than silently coercing or
 * throwing out of the stream. Conformant input at a schema boundary (e.g.
 * `topK` at its max) must reach `execute()` and produce a normal
 * `tool-result`. Neither direction is exercised by `packages/agents/tests/**`,
 * which only ever scripts already-valid tool-call input.
 *
 * The `tool-error` part's `error` crosses a step-serialization boundary and
 * arrives as a stringified `AI_InvalidToolInputError: Invalid input for tool
 * <name>: ...` (confirmed empirically, not `instanceof InvalidToolInputError`
 * — the class survives only up to the boundary, not across it), so the
 * assertions below match that string form.
 */

/** Locates the `tool-error` part for `toolName` and asserts it names schema rejection. */
function expectSchemaRejection(
	content: Array<{ type: string; toolName?: string; error?: unknown }>,
	toolName: string,
) {
	const toolError = content.find(
		(part) => part.type === "tool-error" && part.toolName === toolName,
	);
	expect(toolError).toBeDefined();
	expect(String(toolError?.error)).toContain("AI_InvalidToolInputError");
	expect(String(toolError?.error)).toContain(`Invalid input for tool ${toolName}`);
}

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
	matches: RetrievalMatch[] = [
		{
			chunkId: "22222222-2222-4222-8222-222222222222",
			documentId: "11111111-1111-4111-8111-111111111111",
			source: "docs/onboarding.md",
			ordinal: 0,
			content: "New hires finish security training in week one.",
			distance: 0.1,
		},
	];
	async searchByVector() {
		return this.matches;
	}
}

function makeAgent(model: MockLanguageModelV4) {
	const retrieval = createRetrievalCapability(makeDeps(), {
		store: new FakeStore(),
		embedQuery: fakeEmbedQuery,
	});
	return createChatAgent(makeDeps(), { model, retrieval });
}

/**
 * A model turn that calls `toolName` with `input`, then a wrap-up text turn.
 * Two turns because the loop always feeds a tool call's result (or error)
 * back to the model for a second turn before it can produce a final answer,
 * regardless of whether that first call succeeded or failed schema parsing.
 */
function callThenAnswer(toolName: string, input: unknown) {
	return [
		{
			stream: simulateReadableStream({
				chunks: [
					{
						type: "tool-call" as const,
						toolCallId: "call-1",
						toolName,
						input: JSON.stringify(input),
					},
					{
						type: "finish" as const,
						finishReason: { unified: "tool-calls", raw: undefined },
						usage: USAGE,
					},
				],
			}),
		},
		{
			stream: simulateReadableStream({
				chunks: [
					{ type: "text-start" as const, id: "t2" },
					{ type: "text-delta" as const, id: "t2", delta: "承知しました" },
					{ type: "text-end" as const, id: "t2" },
					{
						type: "finish" as const,
						finishReason: { unified: "stop", raw: undefined },
						usage: USAGE,
					},
				],
			}),
		},
	];
}

describe("tier1 golden set — schema conformance rejects invalid input (R4.4)", () => {
	test("getCurrentTime: a non-string timeZone fails schema parse before execute()", async () => {
		const model = new MockLanguageModelV4({
			doStream: callThenAnswer("getCurrentTime", { timeZone: 123 }),
		});

		const result = await makeAgent(model).stream({ messages: userMessage("今何時？") });
		expectSchemaRejection(await result.content, "getCurrentTime");
		// Schema rejection happens before execute(): no tool-result was produced.
		expect(await result.toolResults).toHaveLength(0);
		// The loop still continues past the error to let the model respond (R1.7).
		expect(model.doStreamCalls).toHaveLength(2);
	});

	test("searchDocuments: topK over its max(20) fails schema parse before execute()", async () => {
		const model = new MockLanguageModelV4({
			doStream: callThenAnswer("searchDocuments", { query: "onboarding", topK: 21 }),
		});

		const result = await makeAgent(model).stream({ messages: userMessage("入社時の手続きは？") });
		expectSchemaRejection(await result.content, "searchDocuments");
		expect(await result.toolResults).toHaveLength(0);
	});

	test("searchDocuments: an empty query fails its min(1) constraint before execute()", async () => {
		const model = new MockLanguageModelV4({
			doStream: callThenAnswer("searchDocuments", { query: "" }),
		});

		const result = await makeAgent(model).stream({ messages: userMessage("検索して") });
		expectSchemaRejection(await result.content, "searchDocuments");
		expect(await result.toolResults).toHaveLength(0);
	});
});

describe("tier1 golden set — schema conformance accepts boundary-valid input (R4.4)", () => {
	test("searchDocuments: topK at its max(20) passes schema parse and reaches execute()", async () => {
		const model = new MockLanguageModelV4({
			doStream: callThenAnswer("searchDocuments", { query: "onboarding", topK: 20 }),
		});

		const result = await makeAgent(model).stream({ messages: userMessage("入社時の手続きは？") });
		const toolResults = await result.toolResults;

		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]?.toolName).toBe("searchDocuments");
		const output = toolResults[0]?.output as { chunks: unknown[] };
		expect(output.chunks).toHaveLength(1);
	});

	test("getCurrentTime: an omitted optional timeZone passes schema parse and reaches execute()", async () => {
		const model = new MockLanguageModelV4({
			doStream: callThenAnswer("getCurrentTime", {}),
		});

		const result = await makeAgent(model).stream({ messages: userMessage("今何時？") });
		const toolResults = await result.toolResults;

		expect(toolResults).toHaveLength(1);
		const output = toolResults[0]?.output as { timeZone: string };
		expect(output.timeZone).toBe("UTC");
	});
});
