import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { parseAiEnv } from "@vaz/schemas/env";
import type { LanguageModel } from "ai";

/**
 * Resolve the chat language model from environment variables.
 *
 * Model/provider selection is derived entirely from env via `@vaz/schemas`'
 * `parseAiEnv` (no model IDs hardcoded here — R1.8/NFR-3):
 *
 * - `AI_PROVIDER=anthropic` (default): Claude (requires ANTHROPIC_API_KEY)
 * - `AI_PROVIDER=ollama`: local LLM, connected via the official
 *   `@ai-sdk/openai-compatible` to Ollama's OpenAI-compatible endpoint (no API key)
 */
export function resolveModel(env: Record<string, string | undefined> = process.env): LanguageModel {
	const aiEnv = parseAiEnv(env);

	switch (aiEnv.AI_PROVIDER) {
		case "anthropic":
			return anthropic(aiEnv.ANTHROPIC_MODEL);
		case "ollama": {
			const ollama = createOpenAICompatible({
				name: "ollama",
				baseURL: aiEnv.OLLAMA_BASE_URL,
			});
			return ollama(aiEnv.OLLAMA_MODEL);
		}
	}
}
