import { resolveVazRole } from "@vaz/config/role-allowlist";

/**
 * VAZ's own `email → role` allowlist (R5.1, Task 18.2). IdP claims are not
 * trusted directly — Entra ID app roles and Google Workspace OIDC id_tokens
 * carry asymmetric (or absent) role information, so `apps/web/src/lib/auth.ts`
 * derives `role` from this single allowlist instead (docs/spikes/phase5-idp.md §7).
 *
 * `resolveVazRole` takes the allowlist as an (optional, defaulted) parameter so
 * this behavior is testable without depending on the committed `ADMIN_EMAILS`
 * contents (which ship empty until an admin is actually onboarded).
 */
describe("resolveVazRole", () => {
	test("defaults an email not on the allowlist to member", () => {
		expect(resolveVazRole("nobody@example.com", [])).toBe("member");
	});

	test("grants admin to an allowlisted email", () => {
		expect(resolveVazRole("admin@example.com", ["admin@example.com"])).toBe("admin");
	});

	test("matching is case-insensitive on both sides", () => {
		expect(resolveVazRole("Admin@Example.com", ["admin@example.com"])).toBe("admin");
		expect(resolveVazRole("admin@example.com", ["ADMIN@EXAMPLE.COM"])).toBe("admin");
	});

	test("uses the committed ADMIN_EMAILS allowlist by default", () => {
		expect(resolveVazRole("nobody@example.com")).toBe("member");
	});
});
