import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	createToolApprovalPolicy,
	isExternallyDrivenTurn,
	UNVERIFIABLE_APPROVAL_DENIAL_REASON,
} from "../src/approval-policy";
import { toRetrievedContextMessage } from "../src/prompt";

/**
 * Unit tests for `createToolApprovalPolicy` (R3.4 / R5.3): the agent-level
 * `toolApproval` policy that suspends a workflow on destructive tool calls.
 *
 * Ownership split: tools DECLARE destructiveness via `needsApproval`
 * (email tool), this policy DECIDES `'user-approval'` (→ the durable
 * engine suspends and awaits a human), and everything else runs
 * normally (`'not-applicable'`). Pure and network-free.
 */

const call = (toolName: string, input: unknown = {}) => ({
	toolName,
	toolCallId: `call-${toolName}`,
	input,
	dynamic: false as const,
});

// A realistic tool set: one destructive (declares needsApproval), one safe.
const tools = {
	sendEmail: tool({
		description: "Send an external email.",
		inputSchema: z.object({ to: z.string(), body: z.string() }),
		execute: async () => "sent",
		needsApproval: true,
	}),
	getTime: tool({
		description: "Return the current time.",
		inputSchema: z.object({}),
		execute: async () => "12:00",
	}),
} satisfies ToolSet;

describe("createToolApprovalPolicy — needsApproval declaration (R3.4)", () => {
	test("suspends (user-approval) a tool that declares needsApproval: true", async () => {
		const policy = createToolApprovalPolicy();
		expect(await policy({ toolCall: call("sendEmail", { to: "a@b.co", body: "hi" }), tools })).toBe(
			"user-approval",
		);
	});

	test("runs a non-destructive tool normally (not-applicable)", async () => {
		const policy = createToolApprovalPolicy();
		expect(await policy({ toolCall: call("getTime"), tools })).toBe("not-applicable");
	});

	test("evaluates a needsApproval predicate against the tool input", async () => {
		const withPredicate = {
			pay: tool({
				description: "Pay a recipient.",
				inputSchema: z.object({ amount: z.number() }),
				execute: async () => "paid",
				needsApproval: async ({ amount }) => amount > 1000,
			}),
		} satisfies ToolSet;
		const policy = createToolApprovalPolicy();

		expect(await policy({ toolCall: call("pay", { amount: 5000 }), tools: withPredicate })).toBe(
			"user-approval",
		);
		expect(await policy({ toolCall: call("pay", { amount: 10 }), tools: withPredicate })).toBe(
			"not-applicable",
		);
	});
});

describe("createToolApprovalPolicy — explicit configuration", () => {
	test("treats names in destructiveTools as destructive even without a declaration", async () => {
		const policy = createToolApprovalPolicy({ destructiveTools: ["getTime"] });
		expect(await policy({ toolCall: call("getTime"), tools })).toBe("user-approval");
	});

	test("isDestructive escalates a normally-safe call (R5.3 hook)", async () => {
		const policy = createToolApprovalPolicy({
			isDestructive: (toolCall) => toolCall.toolName === "getTime",
		});
		expect(await policy({ toolCall: call("getTime"), tools })).toBe("user-approval");
	});

	test("a false isDestructive is additive: it does not suppress a needsApproval declaration", async () => {
		const policy = createToolApprovalPolicy({ isDestructive: () => false });
		expect(await policy({ toolCall: call("sendEmail", { to: "a@b.co", body: "x" }), tools })).toBe(
			"user-approval",
		);
	});
});

describe("createToolApprovalPolicy — unknown tools", () => {
	test("defaults to not-applicable when the tool is unknown / no tools provided", async () => {
		const policy = createToolApprovalPolicy();
		expect(await policy({ toolCall: call("mystery") })).toBe("not-applicable");
	});
});

// A retrieved-context message, exactly as `toRetrievedContextMessage`
// would inject a RAG result into a turn — the R5.3 "externally-read content" signal.
const retrievedContextMessage = toRetrievedContextMessage([
	{
		chunkId: "22222222-2222-4222-8222-222222222222",
		documentId: "11111111-1111-4111-8111-111111111111",
		source: "docs/onboarding.md",
		ordinal: 0,
		content: "New hires finish security training in week one.",
		score: 0.9,
	},
]);
if (!retrievedContextMessage) throw new Error("expected a retrieved-context message");

describe("createToolApprovalPolicy — R5.3 externally-driven-turn escalation", () => {
	const withPredicate = {
		pay: tool({
			description: "Pay a recipient.",
			inputSchema: z.object({ amount: z.number() }),
			execute: async () => "paid",
			needsApproval: async ({ amount }) => amount > 1000,
		}),
	} satisfies ToolSet;

	test("forces user-approval when a needsApproval predicate evaluates false but the turn carries retrieved context", async () => {
		const policy = createToolApprovalPolicy();
		const result = await policy({
			toolCall: call("pay", { amount: 10 }),
			tools: withPredicate,
			messages: [retrievedContextMessage],
		});
		expect(result).toBe("user-approval");
	});

	test("does not escalate the same call when the turn carries no retrieved context", async () => {
		const policy = createToolApprovalPolicy();
		const result = await policy({
			toolCall: call("pay", { amount: 10 }),
			tools: withPredicate,
			messages: [{ role: "user", content: "how much would a $10 payment cost?" }],
		});
		expect(result).toBe("not-applicable");
	});

	test("does not escalate a tool with no needsApproval declaration at all, even with retrieved context", async () => {
		const policy = createToolApprovalPolicy();
		const result = await policy({
			toolCall: call("getTime"),
			tools,
			messages: [retrievedContextMessage],
		});
		expect(result).toBe("not-applicable");
	});

	test("isDestructive receives the turn's messages, so a caller can build its own escalation signal", async () => {
		const seenMessages: unknown[] = [];
		const policy = createToolApprovalPolicy({
			isDestructive: (_toolCall, _tools, messages) => {
				seenMessages.push(messages);
				return false;
			},
		});
		await policy({ toolCall: call("getTime"), tools, messages: [retrievedContextMessage] });
		expect(seenMessages).toEqual([[retrievedContextMessage]]);
	});

	test("a caller-supplied isExternallyDriven signal forces approval even without a delimiter in messages (sticky-taint seam)", async () => {
		const policy = createToolApprovalPolicy({ isExternallyDriven: () => true });
		const result = await policy({
			toolCall: call("pay", { amount: 10 }),
			tools: withPredicate,
			messages: [{ role: "user", content: "no delimiter here" }],
		});
		expect(result).toBe("user-approval");
	});

	test("a false isExternallyDriven signal does NOT suppress the default delimiter scan (additive, never weakens)", async () => {
		const policy = createToolApprovalPolicy({ isExternallyDriven: () => false });
		const result = await policy({
			toolCall: call("pay", { amount: 10 }),
			tools: withPredicate,
			messages: [retrievedContextMessage],
		});
		// The caller signal is false, but the built-in delimiter scan still fires.
		expect(result).toBe("user-approval");
	});
});

describe("createToolApprovalPolicy — unverifiable approvals fail closed (R5.6)", () => {
	test("denies (not suspends) a needsApproval tool when approvals cannot be verified", async () => {
		const policy = createToolApprovalPolicy({ approvalsAreVerifiable: false });

		// 'user-approval' here would be theatre: with no signing key the SDK skips
		// signature verification, so the client could answer its own question.
		expect(
			await policy({ toolCall: call("sendEmail", { to: "a@b.co", body: "hi" }), tools }),
		).toEqual({ type: "denied", reason: UNVERIFIABLE_APPROVAL_DENIAL_REASON });
	});

	test("denies the R5.3 externally-driven escalation too, rather than asking", async () => {
		const policy = createToolApprovalPolicy({ approvalsAreVerifiable: false });
		const withPredicate = {
			pay: tool({
				description: "Pay a recipient.",
				inputSchema: z.object({ amount: z.number() }),
				execute: async () => "paid",
				// Would evaluate to false for this input; R5.3 escalates it anyway.
				needsApproval: async ({ amount }) => amount > 1000,
			}),
		} satisfies ToolSet;

		expect(
			await policy({
				toolCall: call("pay", { amount: 10 }),
				tools: withPredicate,
				messages: [retrievedContextMessage],
			}),
		).toEqual({ type: "denied", reason: UNVERIFIABLE_APPROVAL_DENIAL_REASON });
	});

	test("leaves non-approval-capable tools running normally", async () => {
		const policy = createToolApprovalPolicy({ approvalsAreVerifiable: false });

		// Failing closed narrows what may run WITHOUT approval to nothing new — a
		// tool that never needed approval is unaffected.
		expect(await policy({ toolCall: call("getTime"), tools })).toBe("not-applicable");
	});

	test("suspends as usual once approvals are verifiable", async () => {
		const policy = createToolApprovalPolicy({ approvalsAreVerifiable: true });
		expect(await policy({ toolCall: call("sendEmail", { to: "a@b.co", body: "hi" }), tools })).toBe(
			"user-approval",
		);
	});
});

describe("isExternallyDrivenTurn", () => {
	test("is true when a message carries a retrieved-context block", () => {
		expect(isExternallyDrivenTurn([retrievedContextMessage])).toBe(true);
	});

	test("is false for ordinary conversation messages", () => {
		expect(isExternallyDrivenTurn([{ role: "user", content: "hello" }])).toBe(false);
	});

	test("is false for an empty turn", () => {
		expect(isExternallyDrivenTurn([])).toBe(false);
	});
});
