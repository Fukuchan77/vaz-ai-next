import { hkdfSync } from "node:crypto";
import { MIN_APPROVAL_SIGNING_KEY_LENGTH, parseAiEnv } from "@vaz/schemas/env";

/**
 * Tool-approval signing-key resolution (R3.4 / R5.6).
 *
 * WHY THIS EXISTS: the AI SDK's `toolApproval` mechanism pauses a run and asks a
 * human, then resumes from the `tool-approval-response` the client sends back.
 * That response is client-supplied data, and `convertToModelMessages` rebuilds
 * the matching `tool-approval-request` part out of the SAME client message — so
 * the SDK's `InvalidToolApprovalError` ("no matching tool-approval-request")
 * can never fire for a hand-crafted payload: the forged pair always agrees with
 * itself. The only server-side check that distinguishes an approval this server
 * actually issued from one a client invented is the HMAC signature the SDK adds
 * to each request and verifies on each response — and that whole code path is
 * skipped unless `streamText` is given a `toolApprovalSecret`.
 *
 * Left unset, a client that knows a tool name and its input schema can approve
 * its own destructive tool call. In this repo the empty `RECIPIENT_ALLOWLIST`
 * (`@vaz/tools/allowlist`, R5.4) happened to stop the send anyway — which is
 * exactly the "two independent controls, neither substitutes for the other"
 * property AGENTS.md claims, but it means the HITL gate itself was forgeable.
 *
 * RESOLUTION ORDER: an explicit `TOOL_APPROVAL_SECRET` wins (a dedicated key can
 * be rotated without invalidating every session cookie) and is used verbatim —
 * it exists for exactly this purpose, so there is nothing to separate it from.
 * Otherwise `AUTH_SECRET` — already mandatory for Auth.js, so an otherwise-
 * correctly configured deployment is covered with no new ops step — PROVIDED it
 * meets the same {@link MIN_APPROVAL_SIGNING_KEY_LENGTH} floor
 * `TOOL_APPROVAL_SECRET` does (`AUTH_SECRET` has no length floor of its own;
 * Auth.js doesn't enforce one, so a short one is rejected as a signing key
 * rather than silently used as a brute-forceable HMAC key). Unlike the
 * dedicated key, a usable `AUTH_SECRET` is never handed to the SDK as-is: it is
 * run through HKDF-SHA256 with a fixed, purpose-specific `info` string first
 * (see {@link deriveApprovalSigningKeyFromAuthSecret}). That domain separation
 * means an attacker who somehow observes a tool-approval signature learns
 * nothing usable against Auth.js's own use of the same variable (session
 * cookie signing), and vice versa — the two uses share a secret, not a key.
 * With neither usable this returns `undefined` and the caller MUST fail closed
 * (see `buildStreamTextOptions` → `approvalsAreVerifiable`).
 *
 * A too-short `AUTH_SECRET` returns `undefined` rather than throwing: unlike
 * `TOOL_APPROVAL_SECRET` (dedicated to this feature, so a schema failure on it
 * is unambiguously a config mistake worth crashing loudly for),
 * `AUTH_SECRET` is a pre-existing, unrelated Auth.js variable and a chat
 * request must not fail because of a length requirement this module imposes
 * on someone else's setting — it only stops being usable as a signing key.
 * `resolveApprovalSigningKeyStatus` reports which case applies so a caller can
 * log/deny with a specific, accurate reason instead of a generic "unset".
 *
 * The value is read per call (never module-cached) so rotating the variable takes
 * effect without a restart, matching `resolveModel()`'s per-request contract.
 */

/** A resolved signing key: the SDK's `experimental_toolApprovalSecret` accepts either. */
export type ApprovalSigningKey = string | Uint8Array;

/**
 * Why {@link resolveApprovalSigningKeyStatus} could not resolve a usable key —
 * distinct causes so a caller can log/deny accurately instead of collapsing
 * both into "nothing is configured".
 */
export type ApprovalSigningKeyAbsenceReason =
	/** Neither `TOOL_APPROVAL_SECRET` nor `AUTH_SECRET` is set. */
	| "unset"
	/**
	 * `AUTH_SECRET` is set (so Auth.js itself is presumably working) but shorter
	 * than {@link MIN_APPROVAL_SIGNING_KEY_LENGTH}, so it is rejected as a
	 * signing key rather than reused as a brute-forceable HMAC key.
	 */
	| "auth-secret-too-short";

export type ApprovalSigningKeyStatus =
	| { key: ApprovalSigningKey; source: "TOOL_APPROVAL_SECRET" | "AUTH_SECRET" }
	| { key: undefined; reason: ApprovalSigningKeyAbsenceReason };

/**
 * HKDF `info` string for deriving the tool-approval signing key from
 * `AUTH_SECRET` — purpose-specific and fixed, so the derived key is bound to
 * this one use and cannot be confused with Auth.js's own derivation from the
 * same variable. Versioned (`v1`) so a future change to the derivation can
 * roll forward without ambiguity about which scheme produced a given key.
 */
const AUTH_SECRET_HKDF_INFO = "vaz-ai-next:tool-approval-signing:v1";

/**
 * Output length in bytes for the HKDF-derived key. 32 bytes (256 bits) matches
 * the SHA-256 block size the SDK's HMAC signing uses
 * (`crypto.subtle.importKey("raw", ..., { name: "HMAC", hash: "SHA-256" })`),
 * and comfortably clears {@link MIN_APPROVAL_SIGNING_KEY_LENGTH}.
 */
const DERIVED_KEY_LENGTH_BYTES = 32;

/**
 * Derives a domain-separated signing key from `AUTH_SECRET` via HKDF-SHA256
 * (RFC 5869) instead of handing the SDK that variable's raw value. `AUTH_SECRET`
 * already has a job — Auth.js session encryption — and reusing a secret
 * verbatim across two independent HMAC uses means a weakness or leak in one
 * context (e.g. a future bug that logs a tool-approval signature) bleeds into
 * the other. An empty salt is standard for HKDF when no per-invocation salt is
 * available (RFC 5869 §2.2: a missing salt is treated as a string of zeros);
 * the fixed `info` string is what provides the domain separation.
 */
function deriveApprovalSigningKeyFromAuthSecret(authSecret: string): Uint8Array {
	return new Uint8Array(
		hkdfSync(
			"sha256",
			authSecret,
			new Uint8Array(0),
			AUTH_SECRET_HKDF_INFO,
			DERIVED_KEY_LENGTH_BYTES,
		),
	);
}

/**
 * Full detail behind approval-signing-key resolution: which key (if any)
 * resolved, and — when none did — *why*, so a caller can log or deny with an
 * accurate, specific reason instead of a generic "nothing is configured"
 * (an `AUTH_SECRET` present-but-too-short is a different operator problem than
 * an `AUTH_SECRET` that was never set at all).
 */
export function resolveApprovalSigningKeyStatus(
	env: Record<string, string | undefined> = process.env,
): ApprovalSigningKeyStatus {
	// TOOL_APPROVAL_SECRET goes through the Zod schema (min length
	// MIN_APPROVAL_SIGNING_KEY_LENGTH) and throws loudly if set-but-too-short.
	// Used verbatim: it is dedicated to this one purpose, so there is no other
	// use of it to separate from.
	const dedicated = parseAiEnv(env).TOOL_APPROVAL_SECRET;
	if (dedicated != null) return { key: dedicated, source: "TOOL_APPROVAL_SECRET" };

	const authSecret = env.AUTH_SECRET?.trim();
	if (!authSecret) return { key: undefined, reason: "unset" };
	if (authSecret.length < MIN_APPROVAL_SIGNING_KEY_LENGTH) {
		return { key: undefined, reason: "auth-secret-too-short" };
	}
	return { key: deriveApprovalSigningKeyFromAuthSecret(authSecret), source: "AUTH_SECRET" };
}

/**
 * Resolves the signing key alone, discarding the diagnostic detail — the
 * common case for a caller that only needs the key (or `undefined`) and
 * already fails closed on `undefined` regardless of the reason. Use
 * {@link resolveApprovalSigningKeyStatus} directly when the reason matters
 * (e.g. to log or word a denial message accurately).
 */
export function resolveApprovalSigningKey(
	env: Record<string, string | undefined> = process.env,
): ApprovalSigningKey | undefined {
	return resolveApprovalSigningKeyStatus(env).key;
}
