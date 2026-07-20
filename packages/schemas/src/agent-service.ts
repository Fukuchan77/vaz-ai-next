import type { components } from "@vaz/schemas/generated/agent-service";
import { z } from "zod";

/**
 * Thin hand-written Zod wrapping `services/agent`'s OpenAPI-generated types
 * (Req 3.3, ADR-B). `services/agent/app/schemas.py` (Pydantic) is the sole
 * source of truth for this HTTP boundary (Req 3.1) — these schemas exist only
 * for runtime validation on the TS side (e.g. a nightly job consuming eval
 * results), never for defining the boundary. The `satisfies z.ZodType<...>`
 * clause on each schema keeps its inferred output assignable to the
 * generated type, so a renamed/re-typed field fails `tsc` here; the
 * remaining drift surface (snapshot ↔ generated type ↔ this Zod) is covered
 * by the contract-drift test (Task 6.5).
 */

export const tokenUsageSchema = z.object({
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	total_tokens: z.number().int().nonnegative(),
}) satisfies z.ZodType<components["schemas"]["TokenUsage"]>;

export type TokenUsage = z.infer<typeof tokenUsageSchema>;

// `z.strictObject` mirrors Pydantic's `EvalRequest.model_config = ConfigDict(extra="forbid")`
// (services/agent/app/schemas.py) — unknown fields are rejected here too, not silently stripped.
export const evalRequestSchema = z.strictObject({
	question: z.string().min(1),
	contexts: z.array(z.string()).min(1),
	answer: z.string().min(1),
}) satisfies z.ZodType<components["schemas"]["EvalRequest"]>;

export type EvalRequest = z.infer<typeof evalRequestSchema>;

export const evalResponseSchema = z.object({
	score: z.number().min(0).max(1),
	verdict: z.boolean(),
	judge_model: z.string().min(1),
	usage: tokenUsageSchema,
}) satisfies z.ZodType<components["schemas"]["EvalResponse"]>;

export type EvalResponse = z.infer<typeof evalResponseSchema>;
