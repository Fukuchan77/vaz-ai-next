import { resolveModel } from "@vaz/config/provider";
import { createRetrievalCapability, type RagDatabase } from "@vaz/rag/tools";
import type { AgentDeps } from "@vaz/schemas/deps";
import { createTimeCapability } from "@vaz/tools/index";
import {
	convertToModelMessages,
	isStepCount,
	type LanguageModel,
	streamText,
	type ToolSet,
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

/** The RAG retrieval tool bundle (`{ searchDocuments }`) from `@vaz/rag`. */
export type RetrievalCapability = ReturnType<typeof createRetrievalCapability>;

/**
 * True when `db` is a usable Drizzle client (exposes `select`). Duck-typed so a
 * non-null but non-Drizzle `db` does not silently opt into RAG registration and
 * fail only at tool-execution time.
 */
function isRagDatabase(db: unknown): db is RagDatabase {
	return typeof (db as { select?: unknown } | null | undefined)?.select === "function";
}

/**
 * Construction-time overrides for {@link createChatAgent}.
 *
 * `model` is a test seam: the spec's unit-test strategy drives the agent with
 * `MockLanguageModelV4` (`ai/test`) so tool selection / loop control are
 * verifiable with no network / no LLM call (R1.6). Production callers omit it
 * and the model is resolved from env per turn (see below).
 *
 * `retrieval` is the RAG capability (R2.4). It is a test seam / explicit
 * override; when omitted it is built from `deps` — but only when a datastore is
 * present (see {@link buildChatTools}).
 */
export interface CreateChatAgentOptions {
	model?: LanguageModel;
	retrieval?: RetrievalCapability;
}

/**
 * Assemble the agent's tool set (R1.4 / R2.4).
 *
 * `getCurrentTime` is always registered. The RAG `searchDocuments` tool is
 * registered **only when retrieval is available**: either injected via
 * `options.retrieval`, or built from `deps` when a datastore is present
 * (`deps.db != null`). Phase 1 is stateless (`db: null`) and therefore keeps
 * exactly the Phase 1 tool set — no RAG tool, behavior unchanged (R1.7).
 *
 * Exported so the registration decision is unit-testable without a stream.
 */
export function buildChatTools(
	deps: AgentDeps,
	options: Pick<CreateChatAgentOptions, "retrieval"> = {},
): ToolSet {
	const { getCurrentTime } = createTimeCapability(deps);

	// Register RAG only when `db` is actually a Drizzle-like client (duck-typed on
	// `select`), not merely non-null. A truthy-but-wrong `db` (raw pg Pool, flag
	// object, mock) would otherwise pass and fail only deep inside searchByVector
	// mid-stream; the guard also lets us build `AgentDeps<RagDatabase>` from the
	// narrowed `db` without an unchecked cast (ADR-3: "Phase 2 consumers narrow it").
	const retrieval =
		options.retrieval ??
		(isRagDatabase(deps.db) ? createRetrievalCapability({ ...deps, db: deps.db }) : undefined);

	// A single `ToolSet` record (not a union of shapes): the RAG tool is added
	// only when retrieval is available, so with no datastore the set is exactly
	// Phase 1's `{ getCurrentTime }` (R1.7).
	const tools: ToolSet = { getCurrentTime };
	if (retrieval) {
		tools.searchDocuments = retrieval.searchDocuments;
	}
	return tools;
}

/**
 * `createChatAgent(deps)` — the chat agent core (R1.3, R2.4).
 *
 * Orchestration lives here, not in the route; the route is a thin HTTP⇔Agent
 * adapter (Task 6.3) that validates input and bridges the returned stream
 * through `toUIMessageStream` → `createUIMessageStreamResponse`.
 *
 * Tools (see {@link buildChatTools}): the Phase 1 `getCurrentTime` tool always,
 * plus the RAG `searchDocuments` tool when a datastore is available (R2.4). The
 * retrieval tool returns typed `RetrievedChunk` / `Citation` values as its tool
 * result. That content is untrusted corpus text; the explicit delimiting /
 * injection hardening (R5.2) is deferred to Phase 5 and is not implemented here
 * — the result reaches the model as a tool-role message (never merged into the
 * system prompt). With no datastore (`db: null`) the tool set is exactly Phase
 * 1's, so the chat path is behavior-equivalent to before RAG (R1.7).
 *
 * Runtime concerns arrive via `deps` (ADR-3): the time capability reads
 * `deps.now()` from closure; the retrieval capability reads `deps.db` /
 * `deps.logger`. The model is resolved lazily inside `stream()` via
 * `@vaz/config`'s `resolveModel()` (no model IDs hardcoded here — R1.8/NFR-3),
 * so provider switching stays per-request. A unit test may inject
 * `options.model` (bypass env / network, R1.6) and `options.retrieval`.
 */
export function createChatAgent(deps: AgentDeps, options: CreateChatAgentOptions = {}) {
	const tools = buildChatTools(deps, options);

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
