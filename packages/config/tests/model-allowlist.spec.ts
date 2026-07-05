import { DEFAULT_MODEL_ID, MODEL_ALLOWLIST } from "@vaz/config/model-allowlist";
import { parseAiEnv } from "@vaz/schemas/env";

/**
 * Drift guard for the model-ID duplication accepted by ADR-5.
 *
 * The canonical allow-list lives in `@vaz/config`, but `@vaz/schemas/src/env.ts`
 * must repeat the default model IDs as Zod `.default()` values because it is the
 * dependency-graph leaf and cannot import `@vaz/config` (that would invert the
 * `config → schemas` direction). Nothing at the type level forces the two to
 * agree, so this test is the enforcement: if a default is changed in one place
 * but not the other, CI fails here.
 */
describe("model-ID single-source drift guard (ADR-5)", () => {
	const envDefaults = parseAiEnv({});

	test("env schema defaults equal @vaz/config DEFAULT_MODEL_ID", () => {
		expect(envDefaults.ANTHROPIC_MODEL).toBe(DEFAULT_MODEL_ID.anthropic);
		expect(envDefaults.OLLAMA_MODEL).toBe(DEFAULT_MODEL_ID.ollama);
	});

	test("each default is a member of its provider allow-list", () => {
		expect(MODEL_ALLOWLIST.anthropic).toContain(DEFAULT_MODEL_ID.anthropic);
		expect(MODEL_ALLOWLIST.ollama).toContain(DEFAULT_MODEL_ID.ollama);
	});

	test("the resolved default provider is anthropic", () => {
		expect(envDefaults.AI_PROVIDER).toBe("anthropic");
	});
});
