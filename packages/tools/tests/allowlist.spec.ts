import {
	assertAllowedRecipient,
	isAllowedRecipient,
	RECIPIENT_ALLOWLIST,
	RecipientNotAllowedError,
} from "../src/allowlist";

/**
 * Unit tests for the recipient allow-list enforcement primitive (R5.4).
 * External-send tools (e.g. `createEmailCapability`) are expected to call
 * this before delivery so a destination outside the allow-list never sends,
 * regardless of what drove the tool call. Pure functions, network-free.
 */

describe("RECIPIENT_ALLOWLIST", () => {
	test("ships empty (deliberate, reviewed entries only — same governance as MODEL_ALLOWLIST/ADMIN_EMAILS)", () => {
		expect(RECIPIENT_ALLOWLIST).toEqual([]);
	});
});

describe("isAllowedRecipient", () => {
	test("returns false for any recipient against the default (empty) allow-list", () => {
		expect(isAllowedRecipient("ops@example.com")).toBe(false);
	});

	test("returns true for a recipient present in a custom allow-list", () => {
		expect(isAllowedRecipient("ops@example.com", ["ops@example.com"])).toBe(true);
	});

	test("matches case-insensitively", () => {
		expect(isAllowedRecipient("OPS@Example.com", ["ops@example.com"])).toBe(true);
	});

	test("ignores surrounding whitespace on both sides", () => {
		expect(isAllowedRecipient("  ops@example.com  ", ["ops@example.com"])).toBe(true);
		expect(isAllowedRecipient("ops@example.com", ["  ops@example.com  "])).toBe(true);
	});

	test("returns false for a recipient absent from a non-empty allow-list", () => {
		expect(isAllowedRecipient("attacker@evil.example", ["ops@example.com"])).toBe(false);
	});
});

describe("assertAllowedRecipient", () => {
	test("returns without throwing for an allowed recipient", () => {
		expect(() => assertAllowedRecipient("ops@example.com", ["ops@example.com"])).not.toThrow();
	});

	test("throws RecipientNotAllowedError for a disallowed recipient", () => {
		expect(() => assertAllowedRecipient("attacker@evil.example", ["ops@example.com"])).toThrow(
			RecipientNotAllowedError,
		);
	});

	test("the thrown error carries the recipient and a descriptive message/name", () => {
		try {
			assertAllowedRecipient("attacker@evil.example", ["ops@example.com"]);
			throw new Error("expected assertAllowedRecipient to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(RecipientNotAllowedError);
			const err = error as RecipientNotAllowedError;
			expect(err.name).toBe("RecipientNotAllowedError");
			expect(err.recipient).toBe("attacker@evil.example");
			expect(err.message).toContain("attacker@evil.example");
		}
	});

	test("throws against the default (empty) allow-list when none is supplied", () => {
		expect(() => assertAllowedRecipient("ops@example.com")).toThrow(RecipientNotAllowedError);
	});
});
