import { resolveModel } from "@vaz/config/provider";
import type { AgentDeps } from "@vaz/schemas/deps";
import { createTimeCapability } from "@vaz/tools/index";
import {
	convertToModelMessages,
	isStepCount,
	type LanguageModel,
	streamText,
	type UIMessage,
} from "ai";

/**
 * Max agent steps: let the model keep generating after a tool call. Kept at the
 * value the chat route used before this containment (`isStepCount(5)`) so the
 * migration is behavior-equivalent (R1.7).
 */
const MAX_STEPS = 5;

/** Input to a single chat turn. `messages` are UI messages from the client. */
export interface ChatAgentStreamOptions {
	messages: UIMessage[];
}

/**
 * Construction-time overrides for {@link createChatAgent}.
 *
 * `model` is a test seam: the spec's unit-test strategy drives the agent with
 * `MockLanguageModelV4` (`ai/test`) so tool selection / loop control are
 * verifiable with no network / no LLM call (R1.6). Production callers omit it
 * and the model is resolved from env per turn (see below).
 */
export interface CreateChatAgentOptions {
	model?: LanguageModel;
}

/**
 * `createChatAgent(deps)` — the chat agent core (R1.3).
 *
 * Phase 1 goal is a **behavior-equivalent containment** of the `streamText`
 * call that previously lived inline in `apps/web`'s chat route (R1.7): same
 * tools (`getCurrentTime`), same stop condition (`isStepCount(5)`), same model
 * resolution. Orchestration lives here, not in the route; the route becomes a
 * thin HTTP⇔Agent adapter (Task 6.3) that only validates input and bridges the
 * returned stream through `toUIMessageStream` → `createUIMessageStreamResponse`.
 * `ToolLoopAgent`-ification follows once the regression suite is green.
 *
 * Runtime concerns arrive via `deps` (ADR-3): the time capability reads
 * `deps.now()` from closure instead of `new Date()`, keeping it unit-testable.
 *
 * The model is resolved lazily inside `stream()` via `@vaz/config`'s
 * `resolveModel()` (no model IDs hardcoded here — R1.8/NFR-3), so provider
 * switching stays per-request: env is read on every turn. A unit test may inject
 * `options.model` to bypass env resolution and avoid the network (R1.6).
 */
export function createChatAgent(deps: AgentDeps, options: CreateChatAgentOptions = {}) {
	const { getCurrentTime } = createTimeCapability(deps);
	const tools = { getCurrentTime };

	return {
		async stream({ messages }: ChatAgentStreamOptions) {
			return streamText({
				model: options.model ?? resolveModel(),
				messages: await convertToModelMessages(messages),
				tools,
				stopWhen: isStepCount(MAX_STEPS),
			});
		},
	};
}

/** Public agent handle returned by {@link createChatAgent} (`stream(...)`). */
export type ChatAgent = ReturnType<typeof createChatAgent>;
