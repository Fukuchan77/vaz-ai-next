import {
	type EvalRequest,
	type EvalResponse,
	evalRequestSchema,
	evalResponseSchema,
	type TokenUsage,
	tokenUsageSchema,
} from "@vaz/schemas/agent-service";

/**
 * Thin hand-written Zod wrapping `services/agent`'s OpenAPI-generated types
 * (Req 3.3, ADR-B). Pydantic (`services/agent/app/schemas.py`) is the
 * boundary's source of truth; the constraints asserted here (min-length,
 * score range, non-negative token counts) mirror that model 1:1 so a TS
 * consumer (e.g. nightly parsing an eval response) gets the same runtime
 * guarantees. Structural conformance to the generated type is enforced at
 * compile time in `packages/schemas/src/agent-service.ts`; drift between the
 * OpenAPI snapshot, the generated type, and this Zod is caught by the
 * contract-drift test (Task 6.5), not here.
 */

describe("tokenUsageSchema", () => {
	const valid: TokenUsage = { input_tokens: 120, output_tokens: 340, total_tokens: 460 };

	test("accepts a valid token-usage object", () => {
		expect(tokenUsageSchema.safeParse(valid).success).toBe(true);
	});

	test("accepts zero token counts (e.g. an error before any judge call)", () => {
		expect(
			tokenUsageSchema.safeParse({ input_tokens: 0, output_tokens: 0, total_tokens: 0 }).success,
		).toBe(true);
	});

	test("rejects a negative token count", () => {
		expect(tokenUsageSchema.safeParse({ ...valid, input_tokens: -1 }).success).toBe(false);
	});

	test("rejects a non-integer token count", () => {
		expect(tokenUsageSchema.safeParse({ ...valid, output_tokens: 1.5 }).success).toBe(false);
	});

	test("rejects a missing field", () => {
		const { total_tokens, ...rest } = valid;
		expect(tokenUsageSchema.safeParse(rest).success).toBe(false);
	});
});

describe("evalRequestSchema", () => {
	const valid: EvalRequest = {
		question: "What is the capital of France?",
		contexts: ["Paris is the capital of France."],
		answer: "Paris",
	};

	test("accepts a valid eval request", () => {
		expect(evalRequestSchema.safeParse(valid).success).toBe(true);
	});

	test("rejects an empty contexts array (Pydantic requires min_length=1 — nothing to evaluate against)", () => {
		expect(evalRequestSchema.safeParse({ ...valid, contexts: [] }).success).toBe(false);
	});

	test("rejects a non-string context entry", () => {
		expect(evalRequestSchema.safeParse({ ...valid, contexts: [1] }).success).toBe(false);
	});

	test("rejects an empty question", () => {
		expect(evalRequestSchema.safeParse({ ...valid, question: "" }).success).toBe(false);
	});

	test("rejects an empty answer", () => {
		expect(evalRequestSchema.safeParse({ ...valid, answer: "" }).success).toBe(false);
	});

	test("rejects a missing question", () => {
		const { question, ...rest } = valid;
		expect(evalRequestSchema.safeParse(rest).success).toBe(false);
	});

	test('rejects an unknown field (mirrors Pydantic\'s extra="forbid")', () => {
		expect(evalRequestSchema.safeParse({ ...valid, unexpected: "field" }).success).toBe(false);
	});
});

describe("evalResponseSchema", () => {
	const valid: EvalResponse = {
		score: 0.87,
		verdict: true,
		judge_model: "claude-opus-4-8",
		usage: { input_tokens: 120, output_tokens: 340, total_tokens: 460 },
	};

	test("accepts a valid eval response", () => {
		expect(evalResponseSchema.safeParse(valid).success).toBe(true);
	});

	test("accepts the boundary scores 0 and 1", () => {
		expect(evalResponseSchema.safeParse({ ...valid, score: 0 }).success).toBe(true);
		expect(evalResponseSchema.safeParse({ ...valid, score: 1 }).success).toBe(true);
	});

	test("rejects a score outside [0, 1]", () => {
		expect(evalResponseSchema.safeParse({ ...valid, score: 1.1 }).success).toBe(false);
		expect(evalResponseSchema.safeParse({ ...valid, score: -0.1 }).success).toBe(false);
	});

	test("rejects a malformed nested usage object", () => {
		expect(
			evalResponseSchema.safeParse({
				...valid,
				usage: { input_tokens: -1, output_tokens: 0, total_tokens: 0 },
			}).success,
		).toBe(false);
	});

	test("rejects an empty judge_model", () => {
		expect(evalResponseSchema.safeParse({ ...valid, judge_model: "" }).success).toBe(false);
	});

	test("rejects a missing verdict", () => {
		const { verdict, ...rest } = valid;
		expect(evalResponseSchema.safeParse(rest).success).toBe(false);
	});
});
