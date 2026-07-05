import { z } from "zod";

/**
 * Request body schema for `/api/chat`.
 * Validates the UIMessage shape; part contents are kept loose because the AI SDK's
 * `convertToModelMessages` interprets them, so we only guarantee that `type` exists.
 */
export const chatRequestSchema = z.object({
	messages: z
		.array(
			z.object({
				id: z.string(),
				// `system` intentionally excluded — see packages/schemas/src/chat.ts
				// (prevents client-injected system-level instructions).
				role: z.enum(["user", "assistant"]),
				parts: z.array(z.looseObject({ type: z.string() })),
				metadata: z.unknown().optional(),
			}),
		)
		.min(1, "messages must not be empty"),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
