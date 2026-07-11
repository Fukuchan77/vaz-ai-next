import { resolveModel } from "@vaz/config/provider";
import { createRetrievalCapability, type RagDatabase } from "@vaz/rag/tools";
import type { AgentDeps } from "@vaz/schemas/deps";
import type { RetrievedChunk } from "@vaz/schemas/rag";
import { createTimeCapability } from "@vaz/tools/index";
import {
	convertToModelMessages,
	isStepCount,
	type LanguageModel,
	type ModelMessage,
	type PrepareStepFunction,
	streamText,
	type ToolSet,
	type UIMessage,
} from "ai";
import { createToolApprovalPolicy } from "./approval-policy";
import { createAuditHook } from "./audit-hook";
import { toRetrievedContextMessage } from "./prompt";

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
 * Injects the delimited retrieved-context block (R5.2) into the message
 * stream immediately after a `searchDocuments` call, so `isExternallyDrivenTurn`
 * (`./approval-policy`, R5.3) can actually detect the turn as externally
 * driven — before this wiring, `toRetrievedContextMessage`
 * (`./prompt`) had no caller and the delimiter never reached the
 * message stream. Only the immediately preceding step's tool results are
 * inspected, so a chunk set is injected exactly once, right after the call
 * that produced it.
 *
 * `onExternalContext` fires whenever a block is injected. The delimiter is
 * visible to the approval policy only in the single step it is injected into;
 * an injected instruction can steer a destructive tool call several steps
 * later, so {@link buildStreamTextOptions} uses this callback to latch a
 * sticky per-run taint flag that keeps forcing approval for the rest of the
 * run (R5.3).
 */
function buildPrepareStep(onExternalContext?: () => void): PrepareStepFunction<ToolSet> {
	return ({ steps, messages }) => {
		const lastStep = steps.at(-1);
		const chunks = (lastStep?.toolResults ?? [])
			.filter((result) => result.toolName === "searchDocuments")
			.flatMap((result) => {
				const output = result.output as { chunks?: RetrievedChunk[] } | undefined;
				return output?.chunks ?? [];
			});
		const contextMessage = toRetrievedContextMessage(chunks);
		if (!contextMessage) return {};
		onExternalContext?.();
		return { messages: [...messages, contextMessage] };
	};
}

/**
 * Build the exact options object passed to `streamText`. Exported
 * so every wired defense is unit-testable directly — calling `toolApproval`/
 * `onToolExecutionStart`/`prepareStep` with synthetic input — without needing
 * a live model turn (mirrors {@link buildChatTools}'s "exported so the
 * registration decision is unit-testable without a stream" precedent).
 *
 * Wires: `runtimeContext` (R4.2, lifts `deps.runtimeContext.userId` onto every
 * span `@vaz/config`'s `initTelemetry` enriches); `onToolExecutionStart` (R5.5,
 * the audit-firing hook, `./audit-hook`); `toolApproval` (R3.4/5.3, the HITL
 * decision policy, `./approval-policy`); `prepareStep` (R5.2, see
 * {@link buildPrepareStep}).
 *
 * R5.3 sticky taint: `prepareStep` injects the retrieved-context delimiter for
 * only the step right after retrieval, but a prompt-injected instruction can
 * defer a destructive tool call to a later step. A per-run `externallyDriven`
 * flag (latched the first time any context block is injected) is fed to the
 * approval policy so the turn stays "externally driven" — and destructive-
 * capable tools stay gated behind human approval — for the rest of the run,
 * even after the delimiter scrolls out of the step's message window. The flag
 * is scoped to this call (one per `stream()`), so taint never leaks across
 * requests.
 */
export function buildStreamTextOptions(
	deps: AgentDeps,
	options: CreateChatAgentOptions,
	tools: ToolSet,
	messages: ModelMessage[],
) {
	let externallyDriven = false;
	return {
		model: options.model ?? resolveModel(),
		messages,
		tools,
		stopWhen: isStepCount(MAX_STEPS),
		runtimeContext: { userId: deps.runtimeContext?.userId ?? null, agentName: "chat-agent" },
		toolApproval: createToolApprovalPolicy({
			// Additive sticky signal; the policy still OR-s in its own delimiter scan.
			isExternallyDriven: () => externallyDriven,
		}),
		prepareStep: buildPrepareStep(() => {
			externallyDriven = true;
		}),
		...createAuditHook(deps),
	};
}

/**
 * `createChatAgent(deps)` — the chat agent core (R1.3, R2.4).
 *
 * Orchestration lives here, not in the route; the route is a thin HTTP⇔Agent
 * adapter that validates input and bridges the returned stream
 * through `toUIMessageStream` → `createUIMessageStreamResponse`.
 *
 * Tools (see {@link buildChatTools}): the Phase 1 `getCurrentTime` tool always,
 * plus the RAG `searchDocuments` tool when a datastore is available (R2.4). The
 * retrieval tool returns typed `RetrievedChunk` / `Citation` values as its tool
 * result; `buildStreamTextOptions`'s `prepareStep` additionally
 * injects an explicitly delimited context block (R5.2) right after that call,
 * on top of the tool-role result the SDK appends automatically (never merged
 * into the system prompt). With no datastore (`db: null`) the tool set is
 * exactly Phase 1's, so the chat path is behavior-equivalent to before RAG
 * (R1.7).
 *
 * Runtime concerns arrive via `deps` (ADR-3): the time capability reads
 * `deps.now()` from closure; the retrieval capability reads `deps.db` /
 * `deps.logger`. The model is resolved lazily inside `stream()` via
 * `@vaz/config`'s `resolveModel()` (no model IDs hardcoded here — R1.8/NFR-3),
 * so provider switching stays per-request. A unit test may inject
 * `options.model` (bypass env / network, R1.6) and `options.retrieval`.
 *
 * `deps.runtimeContext` (R5.1) carries the authenticated caller's
 * `{ userId, role }`, populated per-request by `apps/web/src/app/api/chat/route.ts`
 * from `auth()`/`toRuntimeContext()`. `buildStreamTextOptions`
 * lifts `userId` onto `streamText`'s `runtimeContext` (R4.2) — no tool-set
 * change results, so this remains behavior-equivalent for the response itself
 * (R1.7); only span attribution and the HITL/audit wiring below are new.
 */
export function createChatAgent(deps: AgentDeps, options: CreateChatAgentOptions = {}) {
	const tools = buildChatTools(deps, options);

	return {
		async stream({ messages }: ChatAgentStreamOptions) {
			const modelMessages = await convertToModelMessages(messages);
			return streamText(buildStreamTextOptions(deps, options, tools, modelMessages));
		},
	};
}

/** Public agent handle returned by {@link createChatAgent} (`stream(...)`). */
export type ChatAgent = ReturnType<typeof createChatAgent>;
