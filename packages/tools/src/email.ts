import type { AgentDeps } from "@vaz/schemas/deps";
import { tool } from "ai";
import { z } from "zod";

/**
 * Email capability (R3.4) — a representative DESTRUCTIVE tool (external send).
 *
 * `sendEmail` exists to make the HITL approval flow demonstrable end-to-end:
 * it DECLARES `needsApproval`, the destructiveness marker that `@vaz/agents`'s
 * `createToolApprovalPolicy` (Task 12.2) reads to return `'user-approval'` —
 * which the durable engine turns into a suspend awaiting a human (Task 13/14),
 * then resumes on approval (R3.4/3.5). Ownership split (plan): `@vaz/tools`
 * owns the tool definition, its input schema, the deps closure, and the
 * approval DECLARATION; the approval DECISION policy lives in `@vaz/agents`,
 * and the destination allowlist (R5.4) is Task 19.3 — not here.
 *
 * Runtime concerns arrive via `AgentDeps` (ADR-3): `sentAt` is stamped from
 * `deps.now()` (never `new Date()`) and the actual delivery is a `transport`
 * seam (default: a no-network stub) so this is unit-testable and a real SMTP /
 * API transport drops in later without touching the tool.
 */

/** Input to `sendEmail`. `to` is validated as an email address (Zod v4 `z.email`). */
export const sendEmailInputSchema = z.object({
	to: z.email().describe("送信先メールアドレス。"),
	subject: z.string().min(1).describe("件名。"),
	body: z.string().min(1).describe("本文。"),
});

export type SendEmailInput = z.infer<typeof sendEmailInputSchema>;

/** The result of a send: a delivery id plus the recipient and wire timestamp. */
export interface SendEmailResult {
	messageId: string;
	to: string;
	/** ISO-8601 (from `deps.now()`), wire-safe for events/persistence. */
	sentAt: string;
}

/**
 * Delivery seam. Receives the validated message plus the clock-stamped `sentAt`
 * and performs the actual send. The default is a no-network stub; production
 * injects a real SMTP / provider transport.
 */
export type EmailTransport = (
	message: SendEmailInput & { sentAt: Date },
) => Promise<SendEmailResult> | SendEmailResult;

/** Construction-time overrides for {@link createEmailCapability}. */
export interface CreateEmailCapabilityOptions {
	/** Override the delivery transport (default: a network-free stub). */
	transport?: EmailTransport;
}

/**
 * Default transport: no real delivery (there is no mail server in Phase 3).
 * Derives a deterministic `messageId` from the injected clock so behavior is
 * reproducible in tests, and echoes the recipient. Real transports replace it.
 */
function createStubTransport(): EmailTransport {
	return ({ to, sentAt }) => ({
		messageId: `email-${sentAt.getTime()}`,
		to,
		sentAt: sentAt.toISOString(),
	});
}

/**
 * `createEmailCapability(deps)` — the destructive external-send capability
 * (R3.4). Returns a `{ sendEmail }` tool bundle following the `@vaz/tools`
 * pattern (`createTimeCapability`): `execute` reads the clock and logger from
 * the `deps` closure, and delegates delivery to the {@link EmailTransport} seam.
 */
export function createEmailCapability(deps: AgentDeps, options: CreateEmailCapabilityOptions = {}) {
	const transport = options.transport ?? createStubTransport();

	const sendEmail = tool({
		description:
			"外部宛にメールを送信する（破壊的・外部送信）。送信は取り消せないため、実行前に人の承認を要する。",
		inputSchema: sendEmailInputSchema,
		// Destructiveness marker read by the toolApproval policy (Task 12.2). The
		// SDK deprecated `needsApproval` in favor of call-level `toolApproval`, so
		// enforcement lives in `@vaz/agents`; here it is purely the declaration.
		needsApproval: true,
		execute: async (input): Promise<SendEmailResult> => {
			const result = await transport({ ...input, sentAt: deps.now() });
			// R4.7 privacy contract: do NOT record raw tool input (subject/body =
			// potential PII) at info by default — log only the non-sensitive id.
			deps.logger.info("email.sent", { messageId: result.messageId });
			return result;
		},
	});

	return { sendEmail };
}
