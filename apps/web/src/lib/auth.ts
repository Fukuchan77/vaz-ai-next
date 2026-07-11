import { resolveVazRole, type VazRole } from "@vaz/config/role-allowlist";
import { type AuthEnv, parseAuthEnv } from "@vaz/schemas/auth-env";
import NextAuth, { type User } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

/**
 * Auth.js (`next-auth@5`, JWT session strategy) integration — R5.1, Task 18.2.
 * IdP integration method and provider decided in `docs/spikes/phase5-idp.md`.
 *
 * Provider credentials (`AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`, `AUTH_GOOGLE_ID`/
 * `_SECRET`) and the session-signing `AUTH_SECRET` are auto-detected by Auth.js
 * from env by naming convention (no explicit `clientId`/`clientSecret` wiring
 * needed here); only the Entra ID tenant-specific issuer is passed explicitly
 * since it has no fixed value to infer.
 *
 * Role is never read from an IdP claim directly: Entra ID App Roles and Google
 * Workspace's OIDC id_token are asymmetric (the latter has no built-in
 * app-role claim), so `resolveJwtRole` maps the authenticated email through
 * `@vaz/config`'s own allowlist instead (docs/spikes/phase5-idp.md §7).
 */

declare module "next-auth" {
	interface Session {
		user: User & {
			role: VazRole;
		};
	}
}

declare module "next-auth/jwt" {
	interface JWT {
		role?: VazRole;
	}
}

/** Re-exported so `noUnusedLocals` sees the `next-auth/jwt` import as used (it also anchors the module augmentation above). */
export type { JWT };

/** The `{ userId, role }` shape tool execution is scoped by via `deps` (ADR-3, plan.md §Interfaces). */
export interface AuthRuntimeContext {
	userId: string | null;
	role: VazRole | null;
}

/**
 * Builds the enabled Auth.js provider list from the `AUTH_IDP` switch
 * (env-only, no restart — mirrors `resolveModel()`'s `AI_PROVIDER` pattern).
 */
export function buildAuthProviders(idp: AuthEnv["AUTH_IDP"]) {
	if (idp === "google-workspace") {
		return [Google({})];
	}
	return [MicrosoftEntraID({ issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER })];
}

/** Maps an authenticated email to a VAZ role; `undefined` when there is no email to resolve. */
export function resolveJwtRole(email: string | null | undefined): VazRole | undefined {
	return email ? resolveVazRole(email) : undefined;
}

/** Maps an Auth.js session (or `null`, unauthenticated) to `AuthRuntimeContext`. */
export function toRuntimeContext(
	session: { user?: { id?: string | null; role?: VazRole | null } } | null | undefined,
): AuthRuntimeContext {
	return {
		userId: session?.user?.id ?? null,
		role: session?.user?.role ?? null,
	};
}

const authEnv = parseAuthEnv();

export const { handlers, auth, signIn, signOut } = NextAuth({
	providers: buildAuthProviders(authEnv.AUTH_IDP),
	session: { strategy: "jwt" },
	callbacks: {
		jwt({ token, user }) {
			const role = resolveJwtRole(user?.email);
			if (role) {
				token.role = role;
			}
			return token;
		},
		session({ session, token }) {
			// `token.sub` is always set for a JWT-strategy session (Auth.js sets it to
			// the account's identifier at sign-in); the `| undefined` in `JWT.sub`'s
			// type only accounts for the (unreachable here) database-session shape
			// the callback's param type is generically intersected with.
			session.user.id = token.sub as string;
			session.user.role = token.role ?? "member";
			return session;
		},
	},
});
