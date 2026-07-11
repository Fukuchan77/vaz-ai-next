import type { ModelMessage, ToolApprovalStatus, ToolSet } from "ai";
import { RETRIEVED_CONTEXT_BEGIN } from "./prompt";

/**
 * Tool approval policy (R3.4 / R5.3) — the agent-level HITL decision point.
 *
 * The AI SDK models human-in-the-loop as a `toolApproval` callback on
 * `streamText` / `generateText` / `ToolLoopAgent` that returns a
 * {@link ToolApprovalStatus}. The status `'user-approval'` emits an approval
 * request and pauses the run; in VAZ the durable engine (Inngest, Phase 3
 * spike) turns that pause into a suspend-and-resume (`step.waitForEvent`, Task
 * 13/14) so a workflow can wait for a human across restarts (R3.4/3.5/3.8).
 *
 * OWNERSHIP SPLIT (plan): `@vaz/tools` DECLARES a tool destructive via
 * `needsApproval` (Task 12.3 email tool); this module — `@vaz/agents` — owns
 * the DECISION policy that reads that declaration and returns `'user-approval'`,
 * suspending the workflow. Keeping the policy here (not on the tool) is what
 * lets Phase 5 escalate it (Task 19.2, R5.3, lethal trifecta / Rule of Two):
 * a `needsApproval` predicate is written assuming its input can be trusted.
 * When the turn was driven by externally-read, untrusted content (the
 * retrieved-context block `./prompt` wraps RAG results in, Task 19.1), that
 * assumption no longer holds, so this policy forces `'user-approval'` for any
 * approval-capable tool regardless of what the predicate returns — see
 * {@link isExternallyDrivenTurn}. The `isDestructive` hook also gains the
 * turn's `messages` so a caller can build its own such signal.
 *
 * NOTE on `needsApproval`: the AI SDK deprecated the tool-level `needsApproval`
 * field in favor of exactly this call-level `toolApproval` mechanism. VAZ keeps
 * `needsApproval` as the tool's *destructiveness marker* (per R3.4) and does the
 * enforcement here, so the deprecation is honored rather than fought.
 */

/**
 * The tool call fields this policy inspects. A structural subset of the SDK's
 * `TypedToolCall`, so a `createToolApprovalPolicy(...)` result is assignable to
 * a `streamText({ toolApproval })` generic approval function (which passes a
 * richer object) while staying trivial to construct in tests.
 */
export interface ApprovalToolCall {
	toolName: string;
	toolCallId: string;
	input: unknown;
	/** True for MCP / plugin-discovered tools not statically in the tool set. */
	dynamic?: boolean;
}

/** Input handed to a {@link ToolApprovalPolicy} for one tool call. */
export interface ToolApprovalPolicyInput {
	toolCall: ApprovalToolCall;
	/** The tools available to the model; used to read `needsApproval` declarations. */
	tools?: ToolSet;
	/** Messages for the step that produced the call (passed to a needsApproval predicate). */
	messages?: ModelMessage[];
}

/**
 * A `toolApproval` policy: given a tool call, decide whether it must pause for
 * human approval. Shaped to be usable directly as the AI SDK's generic
 * `toolApproval` function.
 */
export type ToolApprovalPolicy = (input: ToolApprovalPolicyInput) => Promise<ToolApprovalStatus>;

/** Construction-time configuration for {@link createToolApprovalPolicy}. */
export interface CreateToolApprovalPolicyOptions {
	/**
	 * Tool names always treated as destructive (→ `'user-approval'`), regardless
	 * of any `needsApproval` declaration. A belt-and-suspenders list for when the
	 * tool set is not available to inspect at decision time.
	 */
	destructiveTools?: Iterable<string>;
	/**
	 * Additional destructiveness classifier (test seam + R5.3 escalation hook).
	 * ADDITIVE: returning `true` forces approval; returning `false`/`undefined`
	 * does NOT suppress a tool's own `needsApproval` declaration — nothing this
	 * policy does can make a declared-destructive tool run without approval.
	 * Receives the turn's `messages` so a caller can build its own
	 * externally-driven-content signal (see {@link isExternallyDrivenTurn} for
	 * the one this policy already applies automatically).
	 */
	isDestructive?: (
		toolCall: ApprovalToolCall,
		tools?: ToolSet,
		messages?: ModelMessage[],
	) => boolean | Promise<boolean>;
}

/**
 * True when the called tool declares itself destructive via `needsApproval`
 * (`true`, or a predicate that evaluates truthy for this input).
 */
async function declaresNeedsApproval(
	toolCall: ApprovalToolCall,
	tools?: ToolSet,
	messages?: ModelMessage[],
): Promise<boolean> {
	const needsApproval = tools?.[toolCall.toolName]?.needsApproval;
	if (needsApproval === true) return true;
	if (typeof needsApproval === "function") {
		return Boolean(
			await needsApproval(toolCall.input, {
				toolCallId: toolCall.toolCallId,
				messages: messages ?? [],
				context: undefined,
			}),
		);
	}
	return false;
}

/** The literal text of one message part (a `TextPart`), or `""` if it carries none. */
function partText(part: unknown): string {
	if (
		typeof part === "object" &&
		part !== null &&
		"type" in part &&
		part.type === "text" &&
		"text" in part &&
		typeof part.text === "string"
	) {
		return part.text;
	}
	return "";
}

/** The plain-text content of a `ModelMessage`, whether `content` is a string or a part array. */
function messageText(message: ModelMessage): string {
	const { content } = message;
	return typeof content === "string" ? content : content.map(partText).join("\n");
}

/**
 * True when the turn that produced this tool call was driven by
 * externally-read, untrusted content — detected by the delimited
 * retrieved-context block `./prompt` wraps RAG results in (Task 19.1,
 * {@link RETRIEVED_CONTEXT_BEGIN}). A `needsApproval` predicate is written
 * assuming its input can be trusted; under prompt injection that assumption
 * doesn't hold, so {@link createToolApprovalPolicy} uses this to force
 * approval regardless of what the predicate returns (R5.3, lethal trifecta /
 * Rule of Two).
 */
export function isExternallyDrivenTurn(messages: readonly ModelMessage[]): boolean {
	return messages.some((message) => messageText(message).includes(RETRIEVED_CONTEXT_BEGIN));
}

/**
 * True when `toolCall`'s tool declares a `needsApproval` field at all — a
 * boolean or a predicate — regardless of what it evaluates to for this call.
 * The R5.3 "approval-capable" signal: a predicate's per-call verdict can be
 * overridden by {@link isExternallyDrivenTurn}, but a tool with no
 * `needsApproval` field at all was never meant to require approval.
 */
function isApprovalCapable(toolCall: ApprovalToolCall, tools?: ToolSet): boolean {
	return tools?.[toolCall.toolName]?.needsApproval !== undefined;
}

/**
 * `createToolApprovalPolicy(options)` — build the HITL `toolApproval` policy
 * (R3.4). Returns `'user-approval'` (suspend for a human) when a tool call is
 * destructive by ANY signal — an `isDestructive` classifier, the
 * `destructiveTools` name set, or the tool's own `needsApproval` declaration —
 * and `'not-applicable'` (run normally) otherwise. Unknown tools (no matching
 * declaration/config) default to `'not-applicable'`; mark them explicitly to
 * require approval.
 */
export function createToolApprovalPolicy(
	options: CreateToolApprovalPolicyOptions = {},
): ToolApprovalPolicy {
	const destructiveNames = new Set(options.destructiveTools ?? []);

	return async ({ toolCall, tools, messages }) => {
		const destructive =
			(await options.isDestructive?.(toolCall, tools, messages)) === true ||
			destructiveNames.has(toolCall.toolName) ||
			(await declaresNeedsApproval(toolCall, tools, messages));

		if (destructive) return "user-approval";

		// R5.3: a needsApproval predicate above may have evaluated to false, but
		// that verdict assumed trustworthy input. Force approval anyway when this
		// turn was driven by externally-read, untrusted content.
		if (isApprovalCapable(toolCall, tools) && isExternallyDrivenTurn(messages ?? [])) {
			return "user-approval";
		}

		return "not-applicable";
	};
}
