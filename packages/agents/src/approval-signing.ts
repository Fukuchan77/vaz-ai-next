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
 * be rotated without invalidating every session cookie). Otherwise `AUTH_SECRET`
 * — already mandatory for Auth.js, so an otherwise-correctly configured
 * deployment is covered with no new ops step — PROVIDED it meets the same
 * {@link MIN_APPROVAL_SIGNING_KEY_LENGTH} floor `TOOL_APPROVAL_SECRET` does;
 * `AUTH_SECRET` has no length floor of its own (Auth.js doesn't enforce one),
 * so a short one is rejected as a signing key rather than silently used as a
 * brute-forceable HMAC key. With neither usable this returns `undefined` and
 * the caller MUST fail closed (see `buildStreamTextOptions` →
 * `approvalsAreVerifiable`).
 *
 * A too-short `AUTH_SECRET` returns `undefined` rather than throwing: unlike
 * `TOOL_APPROVAL_SECRET` (dedicated to this feature, so a schema failure on it
 * is unambiguously a config mistake worth crashing loudly for),
 * `AUTH_SECRET` is a pre-existing, unrelated Auth.js variable and a chat
 * request must not fail because of a length requirement this module imposes
 * on someone else's setting — it only stops being usable as a signing key.
 *
 * The value is read per call (never module-cached) so rotating the variable takes
 * effect without a restart, matching `resolveModel()`'s per-request contract.
 */
export function resolveApprovalSigningKey(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// TOOL_APPROVAL_SECRET goes through the Zod schema (min length
	// MIN_APPROVAL_SIGNING_KEY_LENGTH) and throws loudly if set-but-too-short.
	const dedicated = parseAiEnv(env).TOOL_APPROVAL_SECRET;
	if (dedicated != null) return dedicated;

	const authSecret = env.AUTH_SECRET?.trim();
	if (!authSecret) return undefined;
	if (authSecret.length < MIN_APPROVAL_SIGNING_KEY_LENGTH) return undefined;
	return authSecret;
}
