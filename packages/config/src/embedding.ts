import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { parseAiEnv } from "@vaz/schemas/env";
import type { EmbeddingModel } from "ai";

/**
 * Default embedding model ID — Ollama `nomic-embed-text` (768-dim, R2.3).
 *
 * A legitimate hardcoded model literal: `@vaz/config` is the ADR-5 carve-out
 * for model IDs (mirrors `DEFAULT_MODEL_ID` in `model-allowlist.ts`). The 768
 * dimension it implies is fixed at DDL time in `@vaz/rag` (`EMBEDDING_DIM`).
 */
export const DEFAULT_EMBEDDING_MODEL_ID = "nomic-embed-text";

/** Default embedding provider when `AI_EMBEDDING_PROVIDER` is unset (R2.3). */
export const DEFAULT_EMBEDDING_PROVIDER = "ollama";

/** Treat an empty string as unset so blank env values fall back to defaults. */
function readEnv(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}

/**
 * Resolve the text-embedding model from environment variables (R2.3).
 *
 * Embeddings default to local Ollama (`nomic-embed-text`) so corpus text never
 * leaves the host unless explicitly reconfigured. Selection is env-driven
 * (NFR-3) and shares the provider layer with `resolveModel` (the same
 * `@ai-sdk/openai-compatible` Ollama endpoint). The returned model is consumed
 * via AI SDK `embedMany` at ingest/retrieve time (`@vaz/rag`); construction is
 * lazy (no network here).
 *
 * The formal Zod validation of the embedding env vars lives in `@vaz/schemas`
 * (`aiEnvSchema`, R2.3) and runs here via `parseAiEnv` below: an
 * out-of-enum `AI_EMBEDDING_PROVIDER` fails there with a ZodError before the
 * `switch`'s own guard is reached, so that `default` branch is a defensive
 * backstop rather than the primary check. `OLLAMA_BASE_URL` is validated too.
 *
 * - `AI_EMBEDDING_PROVIDER` (default `ollama`): selects the embedding provider.
 * - `AI_EMBEDDING_MODEL` (default `nomic-embed-text`): the embedding model ID.
 * - `OLLAMA_BASE_URL`: the Ollama OpenAI-compatible endpoint (validated).
 */
export function resolveEmbeddingModel(
	env: Record<string, string | undefined> = process.env,
): EmbeddingModel {
	const aiEnv = parseAiEnv(env);
	const provider = readEnv(env.AI_EMBEDDING_PROVIDER) ?? DEFAULT_EMBEDDING_PROVIDER;
	const modelId = readEnv(env.AI_EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL_ID;

	switch (provider) {
		case "ollama": {
			const ollama = createOpenAICompatible({
				name: "ollama",
				baseURL: aiEnv.OLLAMA_BASE_URL,
			});
			return ollama.embeddingModel(modelId);
		}
		default:
			throw new Error(
				`Unsupported AI_EMBEDDING_PROVIDER "${provider}" (Phase 2 supports "ollama"); ` +
					"the @vaz/schemas env schema constrains valid values.",
			);
	}
}
