import { parseAuthEnv } from "@vaz/schemas/auth-env";

/**
 * `AUTH_IDP` env-driven IdP switch (R5.1, Task 18.2), mirrors `aiEnvSchema`'s
 * `AI_PROVIDER` pattern (`@vaz/schemas/env`): a single leaf-level enum lets
 * `apps/web/src/lib/auth.ts` pick the Auth.js provider set without a restart.
 */
describe("parseAuthEnv", () => {
	test("defaults AUTH_IDP to entra-id when unset", () => {
		expect(parseAuthEnv({}).AUTH_IDP).toBe("entra-id");
	});

	test("accepts an explicit google-workspace override", () => {
		expect(parseAuthEnv({ AUTH_IDP: "google-workspace" }).AUTH_IDP).toBe("google-workspace");
	});

	test("treats an empty string as unset (falls back to the default)", () => {
		expect(parseAuthEnv({ AUTH_IDP: "" }).AUTH_IDP).toBe("entra-id");
	});

	test("rejects an unknown IdP value", () => {
		expect(() => parseAuthEnv({ AUTH_IDP: "okta" })).toThrow();
	});
});
