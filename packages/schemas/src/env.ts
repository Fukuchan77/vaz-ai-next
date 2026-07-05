import { z } from "zod";

/**
 * Schema for AI-provider environment variables.
 * Validated with Zod v4 at startup to catch misconfiguration before runtime.
 */
export const aiEnvSchema = z.object({
	AI_PROVIDER: z.enum(["anthropic", "ollama"]).default("anthropic"),
	ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-4-8"),
	OLLAMA_BASE_URL: z.url().default("http://localhost:11434/v1"),
	OLLAMA_MODEL: z.string().min(1).default("llama3.2"),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;

/** Treat an empty string as unset (guards against blank values in `.env`). */
function emptyToUndefined(value: string | undefined): string | undefined {
	return value === "" ? undefined : value;
}

export function parseAiEnv(env: Record<string, string | undefined> = process.env): AiEnv {
	return aiEnvSchema.parse({
		AI_PROVIDER: emptyToUndefined(env.AI_PROVIDER),
		ANTHROPIC_MODEL: emptyToUndefined(env.ANTHROPIC_MODEL),
		OLLAMA_BASE_URL: emptyToUndefined(env.OLLAMA_BASE_URL),
		OLLAMA_MODEL: emptyToUndefined(env.OLLAMA_MODEL),
	});
}
