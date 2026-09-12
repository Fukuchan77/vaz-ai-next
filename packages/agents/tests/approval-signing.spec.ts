import {
	resolveApprovalSigningKey,
	resolveApprovalSigningKeyStatus,
} from "../src/approval-signing";

/**
 * Unit tests for `resolveApprovalSigningKey`/`resolveApprovalSigningKeyStatus`
 * (R3.4 / R5.6) — the key that makes a returned tool approval verifiable. Env is
 * passed in explicitly (the function takes it as a parameter) so nothing here
 * mutates `process.env`.
 */

// 32 chars is the schema minimum; these are obviously-fake fixtures.
const DEDICATED = "dedicated-approval-key-0123456789";
const AUTH = "authjs-session-secret-0123456789ab";
const AUTH_ALT = "a-completely-different-authjs-secret-xyz";

describe("resolveApprovalSigningKey", () => {
	test("prefers a dedicated TOOL_APPROVAL_SECRET over AUTH_SECRET", () => {
		expect(resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: DEDICATED, AUTH_SECRET: AUTH })).toBe(
			DEDICATED,
		);
	});

	test("falls back to a derived key when only AUTH_SECRET is set", () => {
		const key = resolveApprovalSigningKey({ AUTH_SECRET: AUTH });
		expect(key).toBeInstanceOf(Uint8Array);
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
		const key = resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: "", AUTH_SECRET: AUTH });
		expect(key).toBeInstanceOf(Uint8Array);
	});

	test("rejects a too-short dedicated key loudly instead of signing with it", () => {
		// Fail loud: a 12-char HMAC key is brute-forceable offline from one observed
		// signature, and silently falling back to AUTH_SECRET would hide the typo.
		expect(() => resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: "too-short-key" })).toThrow();
	});

	test("treats a too-short AUTH_SECRET as unusable for signing, not as a valid key", () => {
		// Unlike TOOL_APPROVAL_SECRET, AUTH_SECRET has no length floor of its own —
		// Auth.js doesn't enforce one — so a short-but-otherwise-valid Auth.js secret
		// must not be reused as a brute-forceable HMAC key. Fail closed to undefined
		// (not a throw: this is a pre-existing, unrelated Auth.js setting, and a chat
		// request must not crash over a length requirement this module imposes on it).
		expect(resolveApprovalSigningKey({ AUTH_SECRET: "too-short-auth-secret" })).toBeUndefined();
	});
});

/**
 * Domain separation (review fix): the AUTH_SECRET fallback must never be the
 * raw variable — that would mean this feature's signing key and Auth.js's
 * session-encryption key are literally the same bytes, so a weakness or leak
 * in one context (e.g. a future bug that logs a tool-approval signature)
 * bleeds into the other. These tests don't pin an exact derived value (that
 * would just duplicate the HKDF call as a brittle golden vector) — they check
 * the properties that matter: the derivation is deterministic, keyed on the
 * input, and not simply the input's own bytes.
 */
describe("resolveApprovalSigningKey — AUTH_SECRET domain separation", () => {
	test("the derived key is not the AUTH_SECRET's own UTF-8 bytes", () => {
		const key = resolveApprovalSigningKey({ AUTH_SECRET: AUTH });
		expect(key).toBeInstanceOf(Uint8Array);
		const rawBytes = new TextEncoder().encode(AUTH);
		expect(Buffer.from(key as Uint8Array).equals(Buffer.from(rawBytes))).toBe(false);
	});

	test("derivation is deterministic for the same AUTH_SECRET", () => {
		const first = resolveApprovalSigningKey({ AUTH_SECRET: AUTH }) as Uint8Array;
		const second = resolveApprovalSigningKey({ AUTH_SECRET: AUTH }) as Uint8Array;
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
	});

	test("different AUTH_SECRET values derive different keys", () => {
		const first = resolveApprovalSigningKey({ AUTH_SECRET: AUTH }) as Uint8Array;
		const second = resolveApprovalSigningKey({ AUTH_SECRET: AUTH_ALT }) as Uint8Array;
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
	});

	test("a dedicated TOOL_APPROVAL_SECRET is used verbatim, not derived", () => {
		// Unlike AUTH_SECRET, TOOL_APPROVAL_SECRET is dedicated to this one purpose —
		// there is no other use of it to separate from, and deriving from it would
		// only add complexity with no security benefit.
		expect(resolveApprovalSigningKey({ TOOL_APPROVAL_SECRET: DEDICATED })).toBe(DEDICATED);
	});
});

describe("resolveApprovalSigningKeyStatus", () => {
	test("reports the source alongside a resolved dedicated key", () => {
		expect(resolveApprovalSigningKeyStatus({ TOOL_APPROVAL_SECRET: DEDICATED })).toEqual({
			key: DEDICATED,
			source: "TOOL_APPROVAL_SECRET",
		});
	});

	test("reports the source alongside a resolved AUTH_SECRET-derived key", () => {
		const status = resolveApprovalSigningKeyStatus({ AUTH_SECRET: AUTH });
		expect(status.key).toBeInstanceOf(Uint8Array);
		expect(status).toMatchObject({ source: "AUTH_SECRET" });
	});

	test('reports reason "unset" when neither variable is configured', () => {
		expect(resolveApprovalSigningKeyStatus({})).toEqual({ key: undefined, reason: "unset" });
	});

	test(
		'reports reason "auth-secret-too-short" — distinct from "unset" — so a caller ' +
			"can tell a present-but-rejected AUTH_SECRET apart from nothing being configured at all",
		() => {
			expect(resolveApprovalSigningKeyStatus({ AUTH_SECRET: "too-short-auth-secret" })).toEqual({
				key: undefined,
				reason: "auth-secret-too-short",
			});
		},
	);
});
