import { citationSchema } from "@vaz/schemas/rag";
import {
	type JobEvent,
	jobEventSchema,
	type SpecialistInput,
	type SpecialistResult,
	type SupervisorPlan,
	specialistInputSchema,
	specialistKindSchema,
	specialistResultSchema,
	supervisorPlanSchema,
	workflowStepResultSchema,
	workflowStepSchema,
} from "@vaz/schemas/workflows";

/**
 * Engine-agnostic workflow contracts (R3.3 typed handoff / R3.6 event union).
 *
 * These schemas fix the supervisor→specialist step I/O and the streamed
 * `JobEvent` discriminated union in `@vaz/schemas` (the dep-graph leaf) so the
 * durable engine chosen in the Phase 3 spike (Inngest — `docs/spikes/
 * phase3-durable-engine.md`) can be wired via `EventSchemas.fromZod(...)`
 * WITHOUT this module ever importing the engine.
 */

// Well-formed v4 UUIDs reused across fixtures (mirror the Drizzle uuid PKs).
const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STEP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";
const TS = "2026-07-06T12:00:00.000Z";

const validCitation = { documentId: DOC_ID, source: "docs/onboarding.md", chunkId: CHUNK_ID };

describe("specialistKindSchema", () => {
	test("accepts the three specialist kinds (R3.3)", () => {
		for (const kind of ["rag-research", "document-generation", "data-processing"]) {
			expect(specialistKindSchema.safeParse(kind).success).toBe(true);
		}
	});

	test("rejects an unknown specialist kind", () => {
		expect(specialistKindSchema.safeParse("free-form-chat").success).toBe(false);
	});
});

describe("specialistInputSchema (typed handoff, R3.3)", () => {
	test("accepts a rag-research input", () => {
		const input: SpecialistInput = { kind: "rag-research", query: "onboarding policy", topK: 5 };
		expect(specialistInputSchema.safeParse(input).success).toBe(true);
	});

	test("rejects a rag-research input with an empty query", () => {
		expect(specialistInputSchema.safeParse({ kind: "rag-research", query: "" }).success).toBe(
			false,
		);
	});

	test("rejects a rag-research input with a non-positive topK", () => {
		expect(
			specialistInputSchema.safeParse({ kind: "rag-research", query: "q", topK: 0 }).success,
		).toBe(false);
	});

	test("rejects a rag-research input with a non-integer topK", () => {
		expect(
			specialistInputSchema.safeParse({ kind: "rag-research", query: "q", topK: 1.5 }).success,
		).toBe(false);
	});

	test("accepts a document-generation input and defaults format to markdown", () => {
		const parsed = specialistInputSchema.safeParse({
			kind: "document-generation",
			instructions: "summarise the findings",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success && parsed.data.kind === "document-generation") {
			expect(parsed.data.format).toBe("markdown");
		}
	});

	test("accepts a document-generation input carrying rag citations as a handoff artifact", () => {
		const parsed = specialistInputSchema.safeParse({
			kind: "document-generation",
			instructions: "cite the sources",
			format: "html",
			citations: [validCitation],
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects a document-generation input whose handoff citation is malformed", () => {
		const parsed = specialistInputSchema.safeParse({
			kind: "document-generation",
			instructions: "x",
			citations: [{ ...validCitation, documentId: "not-a-uuid" }],
		});
		expect(parsed.success).toBe(false);
	});

	test("rejects a document-generation input with empty instructions", () => {
		expect(
			specialistInputSchema.safeParse({ kind: "document-generation", instructions: "" }).success,
		).toBe(false);
	});

	test("accepts a data-processing input", () => {
		const input: SpecialistInput = {
			kind: "data-processing",
			operation: "dedupe",
			input: { rows: [1, 2, 2] },
		};
		expect(specialistInputSchema.safeParse(input).success).toBe(true);
	});

	test("rejects a data-processing input with an empty operation", () => {
		expect(
			specialistInputSchema.safeParse({ kind: "data-processing", operation: "", input: null })
				.success,
		).toBe(false);
	});

	test("rejects an unknown specialist kind (discriminated-union guard, not free-form)", () => {
		expect(specialistInputSchema.safeParse({ kind: "chatty", query: "q" }).success).toBe(false);
	});
});

describe("specialistResultSchema (typed handoff, R3.3)", () => {
	test("accepts a rag-research result with citations", () => {
		const result: SpecialistResult = {
			kind: "rag-research",
			findings: "New hires finish security training in week one.",
			citations: [validCitation],
		};
		expect(specialistResultSchema.safeParse(result).success).toBe(true);
	});

	test("rejects a rag-research result whose citation is malformed (contract reuse)", () => {
		const parsed = specialistResultSchema.safeParse({
			kind: "rag-research",
			findings: "f",
			citations: [{ ...validCitation, chunkId: "nope" }],
		});
		expect(parsed.success).toBe(false);
		// the reused citation contract is the same one exported from @vaz/schemas/rag
		expect(citationSchema.safeParse({ ...validCitation, chunkId: "nope" }).success).toBe(false);
	});

	test("accepts a document-generation result", () => {
		const result: SpecialistResult = {
			kind: "document-generation",
			document: { title: "Onboarding Summary", format: "markdown", content: "# Summary" },
		};
		expect(specialistResultSchema.safeParse(result).success).toBe(true);
	});

	test("rejects a document-generation result with an empty document title", () => {
		const parsed = specialistResultSchema.safeParse({
			kind: "document-generation",
			document: { title: "", format: "markdown", content: "x" },
		});
		expect(parsed.success).toBe(false);
	});

	test("accepts a data-processing result", () => {
		expect(
			specialistResultSchema.safeParse({ kind: "data-processing", result: [1, 2] }).success,
		).toBe(true);
	});
});

describe("supervisorPlanSchema / workflowStepSchema (R3.3)", () => {
	const validStep = {
		stepId: STEP_ID,
		task: { kind: "rag-research", query: "onboarding" },
	};

	test("accepts a plan with a goal and at least one typed step", () => {
		const plan: SupervisorPlan = { goal: "brief the new hire", steps: [validStep] };
		expect(supervisorPlanSchema.safeParse(plan).success).toBe(true);
	});

	test("rejects a plan with no steps (a plan must dispatch, R3.3)", () => {
		expect(supervisorPlanSchema.safeParse({ goal: "g", steps: [] }).success).toBe(false);
	});

	test("rejects a plan with an empty goal", () => {
		expect(supervisorPlanSchema.safeParse({ goal: "", steps: [validStep] }).success).toBe(false);
	});

	test("rejects a step with a non-UUID stepId", () => {
		expect(
			supervisorPlanSchema.safeParse({
				goal: "g",
				steps: [{ ...validStep, stepId: "step-1" }],
			}).success,
		).toBe(false);
	});

	test("rejects a step whose task is an unknown specialist kind", () => {
		expect(
			workflowStepSchema.safeParse({ stepId: STEP_ID, task: { kind: "whatever" } }).success,
		).toBe(false);
	});
});

describe("workflowStepResultSchema (R3.3)", () => {
	test("correlates a stepId with a typed specialist result", () => {
		const parsed = workflowStepResultSchema.safeParse({
			stepId: STEP_ID,
			result: { kind: "data-processing", result: 42 },
		});
		expect(parsed.success).toBe(true);
	});

	test("rejects a step result with a non-UUID stepId", () => {
		expect(
			workflowStepResultSchema.safeParse({
				stepId: "x",
				result: { kind: "data-processing", result: 42 },
			}).success,
		).toBe(false);
	});
});

describe("jobEventSchema (typed event discriminated union, R3.6)", () => {
	const base = { jobId: JOB_ID, ts: TS };

	const validEvents: JobEvent[] = [
		{ ...base, type: "step-start", stepId: STEP_ID, kind: "rag-research" },
		{
			...base,
			type: "tool-call",
			stepId: STEP_ID,
			toolCallId: "call_1",
			toolName: "searchDocuments",
			args: { query: "q" },
		},
		{ ...base, type: "token", stepId: STEP_ID, delta: "Hello" },
		{ ...base, type: "completion" },
		{ ...base, type: "error", message: "boom", code: "E_TOOL" },
	];

	test("accepts every event variant (step-start/tool-call/token/completion/error)", () => {
		for (const event of validEvents) {
			expect(jobEventSchema.safeParse(event).success).toBe(true);
		}
	});

	test("rejects an unknown event type", () => {
		expect(jobEventSchema.safeParse({ ...base, type: "heartbeat" }).success).toBe(false);
	});

	test("rejects a step-start event missing its specialist kind", () => {
		expect(jobEventSchema.safeParse({ ...base, type: "step-start", stepId: STEP_ID }).success).toBe(
			false,
		);
	});

	test("rejects an event with a non-ISO timestamp (SSE/JSON wire contract)", () => {
		expect(
			jobEventSchema.safeParse({ jobId: JOB_ID, ts: "yesterday", type: "completion" }).success,
		).toBe(false);
	});

	test("rejects an event with a non-UUID jobId", () => {
		expect(jobEventSchema.safeParse({ jobId: "job-1", ts: TS, type: "completion" }).success).toBe(
			false,
		);
	});

	test("rejects an error event with an empty message", () => {
		expect(jobEventSchema.safeParse({ ...base, type: "error", message: "" }).success).toBe(false);
	});

	test("accepts a completion event carrying a typed step result", () => {
		const parsed = jobEventSchema.safeParse({
			...base,
			type: "completion",
			stepId: STEP_ID,
			result: { kind: "rag-research", findings: "f", citations: [validCitation] },
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts a job-level completion event carrying run metrics (ADR-E, Req 1.5)", () => {
		const parsed = jobEventSchema.safeParse({
			...base,
			type: "completion",
			metrics: {
				stopReason: "natural",
				inputTokens: 120,
				outputTokens: 340,
				totalTokens: 460,
				stepCount: 2,
			},
		});
		expect(parsed.success).toBe(true);
	});

	test("accepts a completion event without metrics (SSE wire backward-compatible)", () => {
		expect(jobEventSchema.safeParse({ ...base, type: "completion" }).success).toBe(true);
	});

	test("rejects a completion event with a malformed metrics object", () => {
		const parsed = jobEventSchema.safeParse({
			...base,
			type: "completion",
			metrics: { stopReason: "timeout", inputTokens: 1, outputTokens: 1, totalTokens: 2 },
		});
		expect(parsed.success).toBe(false);
	});
});
