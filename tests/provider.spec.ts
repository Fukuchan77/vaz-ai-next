import { parseAiEnv } from "@/lib/ai/env";
import { resolveModel } from "@/lib/ai/provider";

describe("parseAiEnv", () => {
	test("未設定なら Anthropic + claude-opus-4-8 がデフォルト", () => {
		const env = parseAiEnv({});
		expect(env).toEqual({
			AI_PROVIDER: "anthropic",
			ANTHROPIC_MODEL: "claude-opus-4-8",
			OLLAMA_BASE_URL: "http://localhost:11434/v1",
			OLLAMA_MODEL: "llama3.2",
		});
	});

	test("空文字列は未設定として扱う", () => {
		const env = parseAiEnv({ AI_PROVIDER: "", ANTHROPIC_MODEL: "" });
		expect(env.AI_PROVIDER).toBe("anthropic");
		expect(env.ANTHROPIC_MODEL).toBe("claude-opus-4-8");
	});

	test("不正なプロバイダー名は Zod エラーになる", () => {
		expect(() => parseAiEnv({ AI_PROVIDER: "openai" })).toThrow();
	});

	test("不正な OLLAMA_BASE_URL は Zod エラーになる", () => {
		expect(() => parseAiEnv({ OLLAMA_BASE_URL: "not-a-url" })).toThrow();
	});
});

describe("resolveModel", () => {
	test("anthropic: 指定モデル ID の言語モデルを返す", () => {
		const model = resolveModel({ AI_PROVIDER: "anthropic" });
		expect(typeof model).not.toBe("string");
		if (typeof model !== "string") {
			expect(model.modelId).toBe("claude-opus-4-8");
			expect(model.provider).toContain("anthropic");
		}
	});

	test("ollama: OpenAI 互換プロバイダー経由のモデルを返す", () => {
		const model = resolveModel({
			AI_PROVIDER: "ollama",
			OLLAMA_MODEL: "qwen3",
			OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
		});
		expect(typeof model).not.toBe("string");
		if (typeof model !== "string") {
			expect(model.modelId).toBe("qwen3");
			expect(model.provider).toContain("ollama");
		}
	});
});
