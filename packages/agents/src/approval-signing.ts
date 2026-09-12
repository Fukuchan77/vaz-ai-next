import { parseAiEnv } from "@vaz/schemas/env";

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
 * deployment is covered with no new ops step. With neither set this returns
 * `undefined` and the caller MUST fail closed (see `buildStreamTextOptions` →
 * `approvalsAreVerifiable`).
 *
 * The value is read per call (never module-cached) so rotating the variable takes
 * effect without a restart, matching `resolveModel()`'s per-request contract.
 */
export function resolveApprovalSigningKey(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	// TOOL_APPROVAL_SECRET goes through the Zod schema (min length 32); AUTH_SECRET
	// is Auth.js's own variable and is taken verbatim rather than re-validated here.
	const dedicated = parseAiEnv(env).TOOL_APPROVAL_SECRET;
	if (dedicated != null) return dedicated;

	const authSecret = env.AUTH_SECRET?.trim();
	return authSecret ? authSecret : undefined;
}
