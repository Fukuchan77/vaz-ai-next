import { emptyToUndefined } from "@vaz/schemas/env-helpers";
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
	// Embedding provider config (R2.3, Phase 2). Default local Ollama so corpus
	// text never leaves the host. Only `ollama` is implemented today (matching
	// `@vaz/config#resolveEmbeddingModel`); future providers (OpenAI/Voyage)
	// extend this enum and that resolver's switch together. The embedding model
	// default duplicates `@vaz/config`'s `DEFAULT_EMBEDDING_MODEL_ID` for the
	// same leaf-can't-import-config reason as the chat model defaults (ADR-5).
	AI_EMBEDDING_PROVIDER: z.enum(["ollama"]).default("ollama"),
	AI_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text"),
	// Cumulative input+output token ceiling for a single chat run (R1.3). The
	// budget predicate in `@vaz/agents`' `buildStreamTextOptions` OR's this
	// against `isStepCount(MAX_STEPS)` in `stopWhen` (ADR-A). Conservative
	// default so pre-existing deployments aren't cut off mid-conversation.
	CHAT_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
	// HMAC key the AI SDK uses to sign every tool-approval REQUEST it emits and
	// to verify the signature on the RESPONSE that comes back (R3.4/R5.6). It is
	// the only thing that makes an approval unforgeable: `convertToModelMessages`
	// rebuilds the `tool-approval-request` part from the client's own UI message,
	// so a client can always present a request/response pair whose `approvalId`
	// agrees with itself. Without a signature to check, that forged pair is
	// honored and the tool executes.
	//
	// Deliberately NOT defaulted: a default would be a shared public secret,
	// which verifies nothing. `@vaz/agents`' `resolveApprovalSigningKey` falls
	// back to `AUTH_SECRET` (already mandatory for Auth.js) so a correctly
	// configured deployment gets this for free, and when neither is set the chat
	// approval policy fails CLOSED (denies approval-capable tools) rather than
	// accepting unverifiable approvals. `min(32)` because a short HMAC key is
	// brute-forceable offline from a single observed signature.
	TOOL_APPROVAL_SECRET: z.string().min(32).optional(),
});

export type AiEnv = z.infer<typeof aiEnvSchema>;

export function parseAiEnv(env: Record<string, string | undefined> = process.env): AiEnv {
	return aiEnvSchema.parse({
		AI_PROVIDER: emptyToUndefined(env.AI_PROVIDER),
		ANTHROPIC_MODEL: emptyToUndefined(env.ANTHROPIC_MODEL),
		OLLAMA_BASE_URL: emptyToUndefined(env.OLLAMA_BASE_URL),
		OLLAMA_MODEL: emptyToUndefined(env.OLLAMA_MODEL),
		AI_EMBEDDING_PROVIDER: emptyToUndefined(env.AI_EMBEDDING_PROVIDER),
		AI_EMBEDDING_MODEL: emptyToUndefined(env.AI_EMBEDDING_MODEL),
		CHAT_TOKEN_BUDGET: emptyToUndefined(env.CHAT_TOKEN_BUDGET),
		TOOL_APPROVAL_SECRET: emptyToUndefined(env.TOOL_APPROVAL_SECRET),
	});
}
