import type { AgentDeps } from "@vaz/schemas/deps";
import { createEmailCapability, type EmailTransport, sendEmailInputSchema } from "../src/email";

/**
 * Unit tests for the destructive email capability (R3.4). `sendEmail` is a
 * representative external-send tool: it DECLARES `needsApproval` (the marker
 * `@vaz/agents`'s `toolApproval` policy reads to suspend the workflow, Task
 * 12.2) and reads runtime concerns from an injected `AgentDeps` closure
 * (ADR-3). Network-free: the send transport is a seam and the clock is pinned.
 */

const PINNED = new Date("2026-03-04T05:06:07.000Z");

type LogCall = { message: string; fields?: Record<string, unknown> };

function makeDeps(): { deps: AgentDeps; infoCalls: LogCall[] } {
	const infoCalls: LogCall[] = [];
	const deps: AgentDeps = {
		db: null,
		logger: {
			debug() {},
			info: (message, fields) => infoCalls.push({ message, fields }),
			warn() {},
			error() {},
		},
		now: () => PINNED,
	};
	return { deps, infoCalls };
}

const VALID = { to: "ops@example.com", subject: "Deploy", body: "Shipping now." };

/** Invoke the tool's execute directly (outside a model loop) with synthetic options. */
async function runSend(
	cap: ReturnType<typeof createEmailCapability>,
	input: { to: string; subject: string; body: string },
) {
	const { execute } = cap.sendEmail;
	if (!execute) throw new Error("sendEmail has no execute");
	return execute(input, { toolCallId: "call-1", messages: [], context: {} });
}

describe("sendEmailInputSchema", () => {
	test("accepts a well-formed message", () => {
		expect(sendEmailInputSchema.safeParse(VALID).success).toBe(true);
	});

	test("rejects an invalid recipient address", () => {
		expect(sendEmailInputSchema.safeParse({ ...VALID, to: "not-an-email" }).success).toBe(false);
	});

	test("rejects an empty subject or body", () => {
		expect(sendEmailInputSchema.safeParse({ ...VALID, subject: "" }).success).toBe(false);
		expect(sendEmailInputSchema.safeParse({ ...VALID, body: "" }).success).toBe(false);
	});
});

describe("createEmailCapability — destructiveness declaration (R3.4)", () => {
	test("sendEmail declares needsApproval so the toolApproval policy suspends it", () => {
		const { deps } = makeDeps();
		const { sendEmail } = createEmailCapability(deps);
		// The marker `@vaz/agents` createToolApprovalPolicy reads → 'user-approval'.
		expect(sendEmail.needsApproval).toBe(true);
	});
});

describe("createEmailCapability — execute (ADR-3 deps closure)", () => {
	test("sends via an injected transport, stamping sentAt from deps.now()", async () => {
		const { deps } = makeDeps();
		const seen: Array<{ to: string; subject: string; body: string; sentAt: Date }> = [];
		const transport: EmailTransport = async (message) => {
			seen.push(message);
			return { messageId: "mid-123", to: message.to, sentAt: message.sentAt.toISOString() };
		};
		const cap = createEmailCapability(deps, { transport });

		const result = await runSend(cap, VALID);

		expect(seen).toEqual([{ ...VALID, sentAt: PINNED }]);
		expect(result).toEqual({ messageId: "mid-123", to: VALID.to, sentAt: PINNED.toISOString() });
	});

	test("default transport returns a clock-derived messageId and ISO sentAt", async () => {
		const { deps } = makeDeps();
		const cap = createEmailCapability(deps);

		const result = await runSend(cap, VALID);

		expect(result.to).toBe(VALID.to);
		expect(result.sentAt).toBe(PINNED.toISOString());
		expect(result.messageId).toContain(String(PINNED.getTime()));
	});

	test("logs at info without leaking the subject/body (R4.7 privacy contract)", async () => {
		const { deps, infoCalls } = makeDeps();
		const cap = createEmailCapability(deps);

		await runSend(cap, VALID);

		expect(infoCalls.length).toBeGreaterThan(0);
		const fields = infoCalls.at(-1)?.fields ?? {};
		expect(fields).toHaveProperty("messageId");
		// Raw tool input (subject/body) must not be recorded at info by default.
		expect(fields).not.toHaveProperty("body");
		expect(fields).not.toHaveProperty("subject");
	});
});
