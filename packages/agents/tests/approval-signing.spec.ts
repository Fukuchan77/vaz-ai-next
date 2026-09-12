import { resolveApprovalSigningKey } from "../src/approval-signing";

/**
 * Unit tests for `resolveApprovalSigningKey` (R3.4 / R5.6) — the key that makes
 * a returned tool approval verifiable. Env is passed in explicitly (the function
 * takes it as a parameter) so nothing here mutates `process.env`.
 */

// 32 chars is the schema minimum; these are obviously-fake fixtures.
const DEDICATED = "dedicated-approval-key-0123456789";
const AUTH = "authjs-session-secret-0123456789ab";

describe("resolveApprovalSigningKey", () => {
	test("prefers a dedicated TOOL_APPROVAL_SECRET over AUTH_SECRET", () => {
		expect(resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: DEDICATED, AUTH_SECRET: AUTH })).toBe(
			DEDICATED,
		);
	});

	test("falls back to AUTH_SECRET, which Auth.js already requires", () => {
		expect(resolveApprovalSigningKey({ AUTH_SECRET: AUTH })).toBe(AUTH);
	});

	test("returns undefined when neither is set, so the caller can fail closed", () => {
		expect(resolveApprovalSigningKey({})).toBeUndefined();
	});

	test("treats a blank AUTH_SECRET as unset rather than as an empty HMAC key", () => {
		expect(resolveApprovalSigningKey({ AUTH_SECRET: "   " })).toBeUndefined();
	});

	test("treats a blank TOOL_APPROVAL_SECRET as unset and still falls back", () => {
		// `emptyToUndefined` in the env schema turns "" into undefined; without that
		// the min(32) check would reject the whole env parse for an unset-but-declared
		// variable (a common shape in .env files and CI secrets).
		expect(resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: "", AUTH_SECRET: AUTH })).toBe(AUTH);
	});

	test("rejects a too-short dedicated key loudly instead of signing with it", () => {
		// Fail loud: a 12-char HMAC key is brute-forceable offline from one observed
		// signature, and silently falling back to AUTH_SECRET would hide the typo.
		expect(() => resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: "too-short-key" })).toThrow();
	});
});
