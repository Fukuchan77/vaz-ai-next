import { trace } from "@opentelemetry/api";
import { resolveModel } from "@vaz/config/provider";
import { createRetrievalCapability, type RagDatabase } from "@vaz/rag/tools";
import type { AgentDeps, RunAuditEntry } from "@vaz/schemas/deps";
import { parseAiEnv } from "@vaz/schemas/env";
import type { RetrievedChunk } from "@vaz/schemas/rag";
import { createTimeCapability } from "@vaz/tools/index";
import {
	convertToModelMessages,
	type GenerateTextEndEvent,
	isStepCount,
	type LanguageModel,
	type ModelMessage,
	type PrepareStepFunction,
	type StopCondition,
	streamText,
	type ToolSet,
	type UIMessage,
} from "ai";
import { createToolApprovalPolicy } from "./approval-policy";
import { createAuditHook } from "./audit-hook";
import { CHAT_SYSTEM_PROMPT, toRetrievedContextMessage } from "./prompt";
import { deriveStopReason } from "./stop-reason";

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
	windowMessages?: WindowMessages;
}

/**
 * Optional per-step history-windowing transform (Req 1.7): given the
 * messages `buildPrepareStep` would otherwise send unmodified, returns the
 * (possibly compacted) list to send instead. Shaped to match the AI SDK's
 * own `pruneMessages({ messages, ... })` helper so a caller can plug that
 * helper — or an equivalent compaction strategy — in directly:
 * `windowMessages: (messages) => pruneMessages({ messages, toolCalls: "before-last-3-messages" })`.
 * Omitted (the default) keeps `buildPrepareStep` byte-equivalent to before
 * this seam existed (`docs/context-budget.md`).
 */
export type WindowMessages = (messages: ModelMessage[]) => ModelMessage[];

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
 *
 * `windowMessages` (Req 1.7) is an optional history-windowing seam: when
 * given, it runs over the step's message list — after any retrieved-context
 * append — every step, not only steps that inject context, since compaction
 * needs to act on the whole growing history. When omitted, behavior is
 * byte-equivalent to before this seam existed: `{}` with no context to
 * inject, or `{ messages: [...messages, contextMessage] }` with one.
 */
function buildPrepareStep(
	onExternalContext?: () => void,
	windowMessages?: WindowMessages,
): PrepareStepFunction<ToolSet> {
	return ({ steps, messages }) => {
		const lastStep = steps.at(-1);
		const chunks = (lastStep?.toolResults ?? [])
			.filter((result) => result.toolName === "searchDocuments")
			.flatMap((result) => {
				const output = result.output as { chunks?: RetrievedChunk[] } | undefined;
				return output?.chunks ?? [];
			});
		const contextMessage = toRetrievedContextMessage(chunks);
		if (contextMessage) onExternalContext?.();

		if (!windowMessages) {
			return contextMessage ? { messages: [...messages, contextMessage] } : {};
		}
		const appended = contextMessage ? [...messages, contextMessage] : messages;
		return { messages: windowMessages(appended) };
	};
}

/**
 * Stop condition (ADR-A, Req 1.3): halts the loop once the run's cumulative
 * input+output tokens reach `budget`. `StopCondition` receives only `{ steps
 * }` (no aggregated usage), so the per-step `usage` is reduced here — the
 * same self-sum the official loop-control budget example uses, since v7's
 * `totalTokens` can include reasoning tokens that don't match input+output.
 */
function buildBudgetStopCondition(budget: number): StopCondition<ToolSet> {
	return ({ steps }) =>
		steps.reduce(
			(total, step) => total + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
			0,
		) >= budget;
}

/**
 * `onEnd` (ADR-A/D, Req 1.4): derives the closed `stop_reason` vocabulary
 * out-of-hook via {@link deriveStopReason} and records it two places —
 * OTel span attributes (`vaz.stop_reason`/`vaz.raw_finish_reason`) and
 * `deps.audit.recordRun` (no raw prompts/tool args, R4.7).
 *
 * Both sinks are fail-soft: a missing/broken tracer must never break a chat
 * run (NFR-4, mirrors `@vaz/config#initTelemetry`'s try/catch), and a sink
 * that doesn't implement `recordRun` is a no-op (ADR-D backward
 * compatibility) rather than an error.
 */
function buildOnEnd(deps: AgentDeps, options: { budget: number; maxSteps: number }) {
	return async (event: GenerateTextEndEvent<ToolSet>) => {
		const stopReason = deriveStopReason({
			finishReason: event.finishReason,
			totalUsage: event.totalUsage,
			steps: event.steps,
			budget: options.budget,
			maxSteps: options.maxSteps,
		});

		try {
			trace.getActiveSpan()?.setAttributes({
				"vaz.stop_reason": stopReason,
				"vaz.raw_finish_reason": event.finishReason,
			});
		} catch {
			// Fail-soft (NFR-4): telemetry attribution must never break the run.
		}

		if (!deps.audit?.recordRun) return;
		const entry: RunAuditEntry = {
			stopReason,
			inputTokens: event.totalUsage.inputTokens ?? 0,
			outputTokens: event.totalUsage.outputTokens ?? 0,
			totalTokens: event.totalUsage.totalTokens ?? 0,
			stepCount: event.steps.length,
			userId: deps.runtimeContext?.userId ?? null,
			jobId: null,
			ts: deps.now(),
		};
		try {
			await deps.audit.recordRun(entry);
		} catch (error) {
			deps.logger.error("onEnd: failed to record run metrics", {
				stopReason,
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
 * {@link buildPrepareStep}), including the optional `options.windowMessages`
 * history-windowing seam (R1.7).
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
	const budget = parseAiEnv().CHAT_TOKEN_BUDGET;
	return {
		model: options.model ?? resolveModel(),
		system: CHAT_SYSTEM_PROMPT,
		messages,
		tools,
		// Array = OR semantics (ADR-A): stop at the step cap OR the cumulative
		// token budget, whichever comes first.
		stopWhen: [isStepCount(MAX_STEPS), buildBudgetStopCondition(budget)],
		runtimeContext: { userId: deps.runtimeContext?.userId ?? null, agentName: "chat-agent" },
		toolApproval: createToolApprovalPolicy({
			// Additive sticky signal; the policy still OR-s in its own delimiter scan.
			isExternallyDriven: () => externallyDriven,
		}),
		prepareStep: buildPrepareStep(() => {
			externallyDriven = true;
		}, options.windowMessages),
		onEnd: buildOnEnd(deps, { budget, maxSteps: MAX_STEPS }),
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
