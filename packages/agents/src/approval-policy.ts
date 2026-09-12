import { MIN_APPROVAL_SIGNING_KEY_LENGTH } from "@vaz/schemas/env";
import type { ModelMessage, ToolApprovalStatus, ToolSet } from "ai";
import { RETRIEVED_CONTEXT_BEGIN } from "./prompt";

/**
 * Tool approval policy (R3.4 / R5.3) — the agent-level HITL decision point.
 *
 * The AI SDK models human-in-the-loop as a `toolApproval` callback on
 * `streamText` / `generateText` / `ToolLoopAgent` that returns a
 * {@link ToolApprovalStatus}. The status `'user-approval'` emits an approval
 * request and pauses the run; in VAZ the durable engine (Inngest, Phase 3
 * spike) turns that pause into a suspend-and-resume (`step.waitForEvent`)
 * so a workflow can wait for a human across restarts (R3.4/3.5/3.8).
 *
 * OWNERSHIP SPLIT: `@vaz/tools` DECLARES a tool destructive via
 * `needsApproval` (email tool); this module — `@vaz/agents` — owns
 * the DECISION policy that reads that declaration and returns `'user-approval'`,
 * suspending the workflow. Keeping the policy here (not on the tool) is what
 * lets Phase 5 escalate it (R5.3, lethal trifecta / Rule of Two):
 * a `needsApproval` predicate is written assuming its input can be trusted.
 * When the turn was driven by externally-read, untrusted content (the
 * retrieved-context block `./prompt` wraps RAG results in), that
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
	/**
	 * ADDITIVE taint source (R5.3): an EXTRA "this turn was driven by
	 * externally-read, untrusted content" signal, OR-ed with the built-in
	 * {@link isExternallyDrivenTurn} delimiter scan. Like {@link isDestructive},
	 * it can only ADD taint — returning `false` NEVER suppresses the default
	 * scan, so nothing supplied here can weaken the control. The delimiter is
	 * present only in the single step right after retrieval, but an injected
	 * instruction can steer a destructive call several steps later; a caller
	 * that tracks the taint out-of-band (e.g. a sticky per-run flag) supplies it
	 * here to keep the run tainted after the delimiter scrolls out of the step's
	 * message window.
	 */
	isExternallyDriven?: (messages: readonly ModelMessage[]) => boolean;
	/**
	 * Whether an approval that comes back from the client can actually be
	 * VERIFIED as one this server issued — i.e. whether the caller also passed a
	 * `toolApprovalSecret` to `streamText`/`generateText` so the SDK signs each
	 * approval request and checks the signature on the response.
	 *
	 * When `false`, returning `'user-approval'` would be theatre: the client can
	 * forge a well-formed `approved: true` for an approval that was never
	 * presented to it (`convertToModelMessages` rebuilds the matching request
	 * from the client's own message, so nothing else catches it) and the tool
	 * runs. So this policy fails CLOSED and returns `'denied'` for every
	 * approval-capable tool instead — no destructive call proceeds on an
	 * unverifiable approval.
	 *
	 * Defaults to `true`: this is a caller-supplied fact about the wiring, not
	 * something the policy can detect. The production wiring point
	 * (`buildStreamTextOptions`) always passes the real value; a unit test that
	 * omits it is exercising the decision logic, not the wiring.
	 */
	approvalsAreVerifiable?: boolean;
	/**
	 * Overrides the reason text on the fail-closed `'denied'` verdict (ignored
	 * unless `approvalsAreVerifiable` is `false`). The generic
	 * {@link UNVERIFIABLE_APPROVAL_DENIAL_REASON} says "nothing is configured",
	 * which is misleading when an `AUTH_SECRET` *is* configured but was rejected
	 * for being too short to sign with — this policy has no visibility into env
	 * vars to tell the two apart itself, so the caller (which resolved the key
	 * and knows why it came back empty) supplies the accurate wording instead.
	 */
	unverifiableReason?: string;
}

/**
 * Reason text on the fail-closed `'denied'` verdict, so an operator reading a
 * denied tool output learns the cause is configuration rather than policy.
 * Default wording for the "nothing is configured at all" case; see
 * {@link CreateToolApprovalPolicyOptions.unverifiableReason} for how a caller
 * overrides this with a more specific reason.
 */
export const UNVERIFIABLE_APPROVAL_DENIAL_REASON =
	"Tool approvals cannot be verified: no TOOL_APPROVAL_SECRET (or AUTH_SECRET) is configured, " +
	"so an approval response cannot be distinguished from a forged one. Refusing the call.";

/**
 * Reason text for the specific case where `AUTH_SECRET` *is* set but is
 * shorter than {@link MIN_APPROVAL_SIGNING_KEY_LENGTH} and so was rejected as a
 * fallback signing key (see `@vaz/agents`' `resolveApprovalSigningKeyStatus`).
 * Distinguishing this from {@link UNVERIFIABLE_APPROVAL_DENIAL_REASON} matters
 * operationally: "unset" points an operator at adding a variable, while this
 * points them at lengthening one that is already there.
 */
export const AUTH_SECRET_TOO_SHORT_DENIAL_REASON =
	"Tool approvals cannot be verified: AUTH_SECRET is set but shorter than " +
	`${MIN_APPROVAL_SIGNING_KEY_LENGTH} characters, so it cannot be used as the tool-approval ` +
	"signing key (and no TOOL_APPROVAL_SECRET is configured). Set a dedicated TOOL_APPROVAL_SECRET " +
	`of at least ${MIN_APPROVAL_SIGNING_KEY_LENGTH} characters, or lengthen AUTH_SECRET. Refusing the call.`;

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
 * retrieved-context block `./prompt` wraps RAG results in
 * ({@link RETRIEVED_CONTEXT_BEGIN}). A `needsApproval` predicate is written
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
 *
 * When `options.approvalsAreVerifiable` is `false`, every verdict that would
 * have been `'user-approval'` becomes `'denied'` instead — asking a human is
 * pointless if the answer that comes back cannot be authenticated. See that
 * option's docs.
 */
export function createToolApprovalPolicy(
	options: CreateToolApprovalPolicyOptions = {},
): ToolApprovalPolicy {
	const destructiveNames = new Set(options.destructiveTools ?? []);
	// Fail closed: an unverifiable approval must not gate a destructive call.
	const needsHuman: ToolApprovalStatus =
		options.approvalsAreVerifiable === false
			? {
					type: "denied",
					reason: options.unverifiableReason ?? UNVERIFIABLE_APPROVAL_DENIAL_REASON,
				}
			: "user-approval";
	// Additive: the built-in delimiter scan OR any caller-supplied extra signal.
	// A caller can only ADD taint, never suppress the default (R5.3 never weakens).
	const externallyDriven = (msgs: readonly ModelMessage[]): boolean =>
		isExternallyDrivenTurn(msgs) || (options.isExternallyDriven?.(msgs) ?? false);

	return async ({ toolCall, tools, messages }) => {
		const destructive =
			(await options.isDestructive?.(toolCall, tools, messages)) === true ||
			destructiveNames.has(toolCall.toolName) ||
			(await declaresNeedsApproval(toolCall, tools, messages));

		if (destructive) return needsHuman;

		// R5.3: a needsApproval predicate above may have evaluated to false, but
		// that verdict assumed trustworthy input. Force approval anyway when this
		// turn was driven by externally-read, untrusted content.
		if (isApprovalCapable(toolCall, tools) && externallyDriven(messages ?? [])) {
			return needsHuman;
		}

		return "not-applicable";
	};
}
