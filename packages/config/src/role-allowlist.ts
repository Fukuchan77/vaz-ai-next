/**
 * The single legitimate location for VAZ's `email → role` mapping (R5.1,
 * Task 18.2), mirroring `model-allowlist.ts`'s "single legitimate placement"
 * pattern (ADR-5).
 *
 * `apps/web/src/lib/auth.ts` does not trust IdP claims directly for role: an
 * Entra ID id_token can carry App Roles, but a Google Workspace OIDC id_token
 * has no equivalent app-specific role claim (would require a separate Admin
 * SDK Directory API call). That asymmetry is why role resolution lives here,
 * keyed off the authenticated email, instead of reading a provider claim
 * (see docs/spikes/phase5-idp.md §7).
 */
export type VazRole = "admin" | "member";

/**
 * Emails granted the `admin` role. Ships empty — an entry here is a deliberate,
 * reviewed, committed decision (same governance as `MODEL_ALLOWLIST`), not a
 * runtime/env-driven toggle. Add an org email to grant admin.
 */
export const ADMIN_EMAILS: readonly string[] = [];

/**
 * Resolves the VAZ role for an authenticated email. Matching is
 * case-insensitive (OIDC email claims are not guaranteed to be lower-cased).
 * `adminEmails` defaults to the committed {@link ADMIN_EMAILS} allowlist and is
 * otherwise only overridden by tests.
 */
export function resolveVazRole(
	email: string,
	adminEmails: readonly string[] = ADMIN_EMAILS,
): VazRole {
	const normalized = email.toLowerCase();
	const isAdmin = adminEmails.some((admin) => admin.toLowerCase() === normalized);
	return isAdmin ? "admin" : "member";
}
