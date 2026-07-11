import type { AgentDeps } from "@vaz/schemas/deps";
import type { RetrievedChunk } from "@vaz/schemas/rag";
import { simulateReadableStream, type ToolSet } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { buildStreamTextOptions, createChatAgent } from "../src/chat-agent";
import { RETRIEVED_CONTEXT_BEGIN } from "../src/prompt";

/**
 * Unit tests for `createChatAgent` (R1.6): tool selection and loop control are
 * verified with **no network and no real LLM call** by injecting a
 * `MockLanguageModelV4` (`ai/test`) through the `options.model` seam and mock
 * `AgentDeps`. These durably lock the contract that the ephemeral probes in
 * Tasks 5.2/5.3 exercised transiently.
 *
 * NOTE (wiring): this spec lives under `packages/agents/tests/**`; the root
 * Vitest `include` is `tests/**` only, so it is picked up once Vitest projects
 * are configured (web=jsdom / node packages=node).
 */

/** V4 usage block reused by every mocked model turn (values are arbitrary). */
const USAGE = {
	inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Mock deps: no DB, no-op logger, a pinned clock so tool output is deterministic. */
function makeDeps(now: Date): AgentDeps {
	return {
		db: null,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		now: () => now,
	};
}

const userMessage = (text: string) => [
	{ id: "m1", role: "user" as const, parts: [{ type: "text" as const, text }] },
];

test("streams a single-step text answer with no tool call (network-free)", async () => {
	const model = new MockLanguageModelV4({
		doStream: [
			{
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "t1" },
						{ type: "text-delta", id: "t1", delta: "こんにちは" },
						{ type: "text-end", id: "t1" },
						{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
					],
				}),
			},
		],
	});

	const agent = createChatAgent(makeDeps(new Date("2026-01-02T03:04:05Z")), { model });
	const result = await agent.stream({ messages: userMessage("こんにちは") });

	expect(await result.text).toBe("こんにちは");
	expect(await result.toolCalls).toHaveLength(0);
	// A single model turn: no tool call → no loop continuation.
	expect(model.doStreamCalls).toHaveLength(1);
});

test("selects getCurrentTime then loops to a final answer (tool selection + loop control)", async () => {
	const now = new Date("2026-01-02T03:04:05Z");
	const model = new MockLanguageModelV4({
		doStream: [
			// Turn 1: the model calls the getCurrentTime tool.
			{
				stream: simulateReadableStream({
					chunks: [
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName: "getCurrentTime",
							input: JSON.stringify({ timeZone: "Asia/Tokyo" }),
						},
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: undefined },
							usage: USAGE,
						},
					],
				}),
			},
			// Turn 2: given the tool result, the model produces the final answer.
			{
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "t2" },
						{ type: "text-delta", id: "t2", delta: "ただいまお伝えしました" },
						{ type: "text-end", id: "t2" },
						{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
					],
				}),
			},
		],
	});

	const agent = createChatAgent(makeDeps(now), { model });
	const result = await agent.stream({ messages: userMessage("今何時？") });

	// Tool selection: the model's call routed to the registered capability.
	const toolCalls = await result.toolCalls;
	expect(toolCalls).toHaveLength(1);
	expect(toolCalls[0]?.toolName).toBe("getCurrentTime");
	expect(toolCalls[0]?.input).toEqual({ timeZone: "Asia/Tokyo" });

	// The tool actually executed with the injected clock (deps closure, R1.4).
	const toolResults = await result.toolResults;
	expect(toolResults).toHaveLength(1);
	expect(toolResults[0]?.output).toMatchObject({ timeZone: "Asia/Tokyo" });
	expect(String((toolResults[0]?.output as { now: string }).now)).toContain("2026");

	// Loop control: the agent continued past the tool call to a second model turn,
	// then stopped (turn 2 has no tool call) — well within isStepCount(5).
	expect(model.doStreamCalls).toHaveLength(2);
	expect(await result.text).toBe("ただいまお伝えしました");
});

test("streams unaffected when deps carries a runtimeContext (R5.1 scoping seam)", async () => {
	// No tool currently branches on `deps.runtimeContext` — this locks the
	// backward-compatibility contract that adding it to `AgentDeps` (R5.1) does
	// not change tool registration or streaming behavior for the Phase 1 tool set.
	const now = new Date("2026-01-02T03:04:05Z");
	const deps: AgentDeps = {
		...makeDeps(now),
		runtimeContext: { userId: "user_123", role: "member" },
	};
	const model = new MockLanguageModelV4({
		doStream: [
			{
				stream: simulateReadableStream({
					chunks: [
						{ type: "text-start", id: "t1" },
						{ type: "text-delta", id: "t1", delta: "ok" },
						{ type: "text-end", id: "t1" },
						{ type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: USAGE },
					],
				}),
			},
		],
	});

	const agent = createChatAgent(deps, { model });
	const result = await agent.stream({ messages: userMessage("hi") });

	expect(await result.text).toBe("ok");
});

/** A fixed RetrievedChunk fixture for prepareStep tests. */
const CHUNK: RetrievedChunk = {
	chunkId: "11111111-1111-4111-8111-111111111111",
	documentId: "22222222-2222-4222-8222-222222222222",
	source: "handbook.md",
	ordinal: 0,
	content: "Vacation requests need manager approval.",
	score: 0.9,
};

describe("buildStreamTextOptions — wiring", () => {
	test("runtimeContext carries deps.runtimeContext.userId and a fixed agentName (R4.2)", () => {
		const deps: AgentDeps = {
			...makeDeps(new Date()),
			runtimeContext: { userId: "user-1", role: "member" },
		};
		const opts = buildStreamTextOptions(deps, {}, {}, []);
		expect(opts.runtimeContext).toEqual({ userId: "user-1", agentName: "chat-agent" });
	});

	test("runtimeContext.userId is null when deps carries no runtimeContext (unauthenticated)", () => {
		const opts = buildStreamTextOptions(makeDeps(new Date()), {}, {}, []);
		expect(opts.runtimeContext).toEqual({ userId: null, agentName: "chat-agent" });
	});

	type ExecStartEvent = Parameters<
		NonNullable<ReturnType<typeof buildStreamTextOptions>["onToolExecutionStart"]>
	>[0];

	test("onToolExecutionStart records the tool execution to deps.audit (R5.5)", async () => {
		const record = vi.fn();
		const deps: AgentDeps = { ...makeDeps(new Date()), audit: { record } };
		const opts = buildStreamTextOptions(deps, {}, {}, []);
		const event = {
			toolCall: { toolName: "getCurrentTime", toolCallId: "call-1", input: {} },
		} as unknown as ExecStartEvent;

		await opts.onToolExecutionStart?.(event);

		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({ tool: "getCurrentTime", jobId: null }),
		);
	});

	type ToolApprovalInput = Parameters<
		NonNullable<ReturnType<typeof buildStreamTextOptions>["toolApproval"]>
	>[0];

	test("toolApproval returns user-approval for a tool declaring needsApproval (R3.4/R5.3)", async () => {
		const opts = buildStreamTextOptions(makeDeps(new Date()), {}, {}, []);
		const input = {
			toolCall: { toolName: "sendEmail", toolCallId: "call-1", input: {} },
			tools: { sendEmail: { needsApproval: true } },
			messages: [],
		} as unknown as ToolApprovalInput;

		const status = await opts.toolApproval?.(input);

		expect(status).toBe("user-approval");
	});

	type PrepareStepInput = Parameters<
		NonNullable<ReturnType<typeof buildStreamTextOptions>["prepareStep"]>
	>[0];

	test("prepareStep is a no-op before any searchDocuments call", async () => {
		const opts = buildStreamTextOptions(makeDeps(new Date()), {}, {}, []);
		const input = { steps: [], messages: [] } as unknown as PrepareStepInput;

		const result = await opts.prepareStep?.(input);

		expect(result).toEqual({});
	});

	test("prepareStep injects a delimited retrieved-context message right after searchDocuments (R5.2/R5.3)", async () => {
		const opts = buildStreamTextOptions(makeDeps(new Date()), {}, {}, []);
		const priorMessages = [{ role: "user" as const, content: "vacation policy?" }];
		const step = {
			toolResults: [
				{
					toolName: "searchDocuments",
					output: { chunks: [CHUNK], citations: [] },
				},
			],
		};

		const result = await opts.prepareStep?.({
			steps: [step],
			messages: priorMessages,
			// biome-ignore lint/suspicious/noExplicitAny: minimal synthetic PrepareStepFunction input
		} as any);

		expect(result?.messages).toHaveLength(2);
		const injected = result?.messages?.at(-1);
		expect(injected?.role).toBe("user");
		expect(String(injected?.content)).toContain(RETRIEVED_CONTEXT_BEGIN);
		expect(String(injected?.content)).toContain(CHUNK.content);
	});

	test("toolApproval keeps forcing approval on a later step once retrieval tainted the run (R5.3 sticky taint)", async () => {
		// An approval-capable tool whose needsApproval predicate evaluates false:
		// only the externally-driven-turn signal can force its approval.
		const tools = { risky: { needsApproval: () => false } } as unknown as ToolSet;
		const opts = buildStreamTextOptions(makeDeps(new Date()), {}, tools, []);

		// Step 1: a searchDocuments result is injected → the run is now tainted.
		await opts.prepareStep?.({
			steps: [{ toolResults: [{ toolName: "searchDocuments", output: { chunks: [CHUNK] } }] }],
			messages: [],
			// biome-ignore lint/suspicious/noExplicitAny: minimal synthetic PrepareStepFunction input
		} as any);
		// Step 2: no searchDocuments this step → the delimiter block is gone from
		// the message stream, but the taint must persist for the rest of the run.
		await opts.prepareStep?.({
			steps: [{ toolResults: [] }],
			messages: [],
			// biome-ignore lint/suspicious/noExplicitAny: minimal synthetic PrepareStepFunction input
		} as any);

		// The risky tool call on step 2 carries NO delimiter in its messages, yet
		// must still be forced to approval because retrieval tainted the run.
		const status = await opts.toolApproval?.({
			toolCall: { toolName: "risky", toolCallId: "call-1", input: {} },
			tools,
			messages: [],
			// biome-ignore lint/suspicious/noExplicitAny: minimal synthetic toolApproval input
		} as any);

		expect(status).toBe("user-approval");
	});
});
