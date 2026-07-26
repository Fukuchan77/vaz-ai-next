import { parseAiEnv } from "@vaz/schemas/env";

/**
 * `CHAT_TOKEN_BUDGET` (R1.3): a conservative cumulative input+output token
 * ceiling read by `@vaz/agents`' `buildStreamTextOptions` budget predicate.
 * Mirrors the `emptyToUndefined` treatment already applied to other fields
 * in `aiEnvSchema` so a blank `.env` value falls back to the default too.
 */
describe("aiEnvSchema CHAT_TOKEN_BUDGET", () => {
	test("defaults to 200_000 when unset", () => {
		expect(parseAiEnv({}).CHAT_TOKEN_BUDGET).toBe(200_000);
	});

	test("coerces a numeric string override", () => {
		expect(parseAiEnv({ CHAT_TOKEN_BUDGET: "50000" }).CHAT_TOKEN_BUDGET).toBe(50_000);
	});

	test("treats an empty string as unset (falls back to the default)", () => {
		expect(parseAiEnv({ CHAT_TOKEN_BUDGET: "" }).CHAT_TOKEN_BUDGET).toBe(200_000);
	});

	test("rejects a non-positive value", () => {
		expect(() => parseAiEnv({ CHAT_TOKEN_BUDGET: "0" })).toThrow();
	});

	test("rejects a non-integer value", () => {
		expect(() => parseAiEnv({ CHAT_TOKEN_BUDGET: "1.5" })).toThrow();
	});
});
