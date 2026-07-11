import type { AgentDeps } from "@vaz/schemas/deps";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createChatAgent } from "../src/chat-agent";

/**
 * Unit tests for `createChatAgent` (R1.6): tool selection and loop control are
 * verified with **no network and no real LLM call** by injecting a
 * `MockLanguageModelV4` (`ai/test`) through the `options.model` seam and mock
 * `AgentDeps`. These durably lock the contract that the ephemeral probes in
 * Tasks 5.2/5.3 exercised transiently.
 *
 * NOTE (wiring): this spec lives under `packages/agents/tests/**`; the root
 * Vitest `include` is `tests/**` only, so it is picked up once Vitest projects
 * are configured in Task 7.1 (web=jsdom / node packages=node).
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

test("streams unaffected when deps carries a runtimeContext (R5.1 scoping seam, Task 18.3)", async () => {
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
