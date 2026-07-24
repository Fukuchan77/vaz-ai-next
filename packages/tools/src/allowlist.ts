/**
 * Recipient allow-list enforcement for external-send tools (R5.4).
 *
 * A prompt-injected or otherwise externally-driven turn (R5.2/5.3) may still
 * reach a destructive tool's `execute` — HITL approval is a
 * parallel control, not a substitute (Rule of Two): an approver reviewing a
 * suspended run is not guaranteed to notice an unexpected destination. This
 * module is the second, independent control — a committed allow-list that a
 * disallowed recipient can never pass, regardless of who or what drove the
 * call.
 *
 * Wired: `createEmailCapability`'s `execute` (email.ts) calls
 * {@link assertAllowedRecipient} before the delivery transport, so a
 * disallowed destination fails closed regardless of the approval outcome.
 */

/**
 * Committed recipients external-send tools may deliver to. Ships empty —
 * same governance as `MODEL_ALLOWLIST` / `ADMIN_EMAILS`: an entry here is a
 * deliberate, reviewed, committed decision, not an env/runtime toggle.
 */
export const RECIPIENT_ALLOWLIST: readonly string[] = [];

/** Thrown by {@link assertAllowedRecipient} for a destination outside the allow-list. */
export class RecipientNotAllowedError extends Error {
	readonly recipient: string;
	constructor(recipient: string) {
		super(`Recipient "${recipient}" is not on the allow-list.`);
		this.name = "RecipientNotAllowedError";
		this.recipient = recipient;
	}
}

/**
 * True when `recipient` is present in `allowlist` (default: the committed
 * {@link RECIPIENT_ALLOWLIST}). Matching is case-insensitive and trims
 * surrounding whitespace on both sides (mirrors `resolveVazRole`'s
 * email-claim handling in `@vaz/config/role-allowlist`).
 */
export function isAllowedRecipient(
	recipient: string,
	allowlist: readonly string[] = RECIPIENT_ALLOWLIST,
): boolean {
	const normalized = recipient.trim().toLowerCase();
	return allowlist.some((allowed) => allowed.trim().toLowerCase() === normalized);
}

/**
 * Enforces the allow-list (R5.4): throws {@link RecipientNotAllowedError} when
 * `recipient` is not on `allowlist`, otherwise returns without effect.
 * Callers must run this before the delivery transport so a disallowed
 * destination never sends.
 */
export function assertAllowedRecipient(
	recipient: string,
	allowlist: readonly string[] = RECIPIENT_ALLOWLIST,
): void {
	if (!isAllowedRecipient(recipient, allowlist)) {
		throw new RecipientNotAllowedError(recipient);
	}
}
