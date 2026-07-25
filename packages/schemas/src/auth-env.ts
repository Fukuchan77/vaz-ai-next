import { z } from "zod";
import { emptyToUndefined } from "./env-helpers";

/**
 * Schema for the Auth.js IdP-selection environment variable (R5.1).
 *
 * Split from `aiEnvSchema` (`@vaz/schemas/env`) — model-provider selection and
 * IdP selection are unrelated concerns — but mirrors its shape: a leaf-level
 * `z.enum(...).default(...)` switch that `apps/web/src/lib/auth.ts` reads to
 * pick the Auth.js provider set, the same pattern `resolveModel()` uses for
 * `AI_PROVIDER` (env-only switch, no restart).
 *
 * OAuth client credentials (`AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`/`_ISSUER`,
 * `AUTH_GOOGLE_ID`/`_SECRET`) are intentionally not modeled here: Auth.js
 * auto-detects them from env by naming convention, and they carry no sensible
 * default to validate against (unlike a provider/model enum).
 */
export const authEnvSchema = z.object({
	AUTH_IDP: z.enum(["entra-id", "google-workspace"]).default("entra-id"),
});

export type AuthEnv = z.infer<typeof authEnvSchema>;

export function parseAuthEnv(env: Record<string, string | undefined> = process.env): AuthEnv {
	return authEnvSchema.parse({
		AUTH_IDP: emptyToUndefined(env.AUTH_IDP),
	});
}
