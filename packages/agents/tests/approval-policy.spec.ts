import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { createToolApprovalPolicy } from "../src/approval-policy";

/**
 * Unit tests for `createToolApprovalPolicy` (R3.4 / R5.3): the agent-level
 * `toolApproval` policy that suspends a workflow on destructive tool calls.
 *
 * Ownership split (plan): tools DECLARE destructiveness via `needsApproval`
 * (Task 12.3 email tool), this policy DECIDES `'user-approval'` (→ the durable
 * engine suspends and awaits a human, Task 13/14), and everything else runs
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
