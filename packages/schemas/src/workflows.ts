import { z } from "zod";
import { citationSchema } from "./rag";

/**
 * Engine-agnostic workflow contracts (R3.3 typed handoff / R3.6 event union).
 *
 * Phase 3 expresses multi-agent work as a supervisor that PLANS and DISPATCHES
 * to specialist agents (RAG research / document generation / data processing)
 * rather than free-form agent-to-agent chat (R3.3). Each step's input and
 * result is fixed here by a Zod schema so the handoff is typed, not prose.
 *
 * This module lives in `@vaz/schemas`, the dependency-graph leaf, and is
 * deliberately **engine-agnostic**: it never imports the durable engine chosen
 * in the Phase 3 spike (Inngest — see `docs/spikes/phase3-durable-engine.md`,
 * Task 11.1). The engine binding happens downstream — the Inngest worker types
 * its events via `EventSchemas.fromZod(...)` against these contracts, and the
 * supervisor (Task 12) / SSE route (Task 13/14) consume them — so swapping the
 * engine later never touches these schemas. Identity fields are `z.uuid()` to
 * mirror the Drizzle `uuid` primary keys of the `Job` / `JobEvent` tables.
 */

/**
 * The specialist agents a supervisor may dispatch to (R3.3). A closed enum —
 * the composition is a fixed set of typed steps, not open-ended chat.
 */
export const specialistKindSchema = z.enum([
	"rag-research",
	"document-generation",
	"data-processing",
]);

export type SpecialistKind = z.infer<typeof specialistKindSchema>;

/** Output format a document-generation specialist may emit. */
export const documentFormatSchema = z.enum(["markdown", "html", "plaintext"]);

export type DocumentFormat = z.infer<typeof documentFormatSchema>;

/**
 * Typed INPUT handed from the supervisor to a specialist (R3.3). Discriminated
 * by `kind` so each specialist's payload is fixed and mutually exclusive.
 *
 * `document-generation.citations` is the cross-step handoff artifact: a prior
 * rag-research step's {@link citationSchema} results flow in as typed evidence
 * (reusing the `@vaz/schemas/rag` contract — one citation shape everywhere).
 * `data-processing.input` is intentionally opaque (`unknown`): the concrete
 * payload is defined by the `operation` and validated at the specialist (Task
 * 12), not over-constrained at the contract boundary.
 */
export const specialistInputSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("rag-research"),
		query: z.string().min(1),
		topK: z.number().int().positive().optional(),
	}),
	z.object({
		kind: z.literal("document-generation"),
		instructions: z.string().min(1),
		format: documentFormatSchema.default("markdown"),
		citations: z.array(citationSchema).optional(),
	}),
	z.object({
		kind: z.literal("data-processing"),
		operation: z.string().min(1),
		input: z.unknown(),
	}),
]);

export type SpecialistInput = z.infer<typeof specialistInputSchema>;

/** A document produced by the document-generation specialist. */
export const generatedDocumentSchema = z.object({
	title: z.string().min(1),
	format: documentFormatSchema,
	content: z.string(),
});

export type GeneratedDocument = z.infer<typeof generatedDocumentSchema>;

/**
 * Typed RESULT handed back from a specialist to the supervisor (R3.3).
 * Discriminated by `kind`, mirroring {@link specialistInputSchema}. A
 * rag-research result carries {@link citationSchema} evidence that a later
 * document-generation step can consume as its `citations` handoff.
 */
export const specialistResultSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("rag-research"),
		findings: z.string(),
		citations: z.array(citationSchema),
	}),
	z.object({
		kind: z.literal("document-generation"),
		document: generatedDocumentSchema,
	}),
	z.object({
		kind: z.literal("data-processing"),
		result: z.unknown(),
	}),
]);

export type SpecialistResult = z.infer<typeof specialistResultSchema>;

/**
 * One planned dispatch: a `stepId` (correlates the plan, its result, and the
 * job events) paired with the typed specialist `task`.
 */
export const workflowStepSchema = z.object({
	stepId: z.uuid(),
	task: specialistInputSchema,
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/**
 * The supervisor's plan (R3.3): a `goal` plus at least one ordered step. `min(1)`
 * enforces that a plan actually dispatches — an empty plan is not a plan.
 */
export const supervisorPlanSchema = z.object({
	goal: z.string().min(1),
	steps: z.array(workflowStepSchema).min(1),
});

export type SupervisorPlan = z.infer<typeof supervisorPlanSchema>;

/** A completed step's result, correlated back to its plan step by `stepId`. */
export const workflowStepResultSchema = z.object({
	stepId: z.uuid(),
	result: specialistResultSchema,
});

export type WorkflowStepResult = z.infer<typeof workflowStepResultSchema>;

/**
 * Fields shared by every {@link jobEventSchema} variant. `ts` is an ISO-8601
 * string (not a `Date`): a `JobEvent` is produced in the worker, persisted, and
 * streamed to the browser over SSE as JSON — a serializable wire timestamp
 * round-trips where a `Date` would not, and maps cleanly onto the `timestamptz`
 * column. Producers stamp it from `deps.now().toISOString()` (ADR-3 clock).
 */
const jobEventBase = {
	jobId: z.uuid(),
	ts: z.iso.datetime(),
} as const;

/**
 * The typed progress-event discriminated union streamed job → SSE → browser
 * (R3.6). Discriminated by `type`:
 *   - `step-start`  — a specialist step began (which step + which specialist).
 *   - `tool-call`   — a tool was invoked within a step.
 *   - `token`       — an incremental output token from a step.
 *   - `completion`  — a step completed (with its result) or the job finished.
 *   - `error`       — a step or the job failed.
 *
 * `completion.stepId`/`result` are optional so the same variant expresses both
 * a single-step completion (with result) and job-level completion.
 */
export const jobEventSchema = z.discriminatedUnion("type", [
	z.object({
		...jobEventBase,
		type: z.literal("step-start"),
		stepId: z.uuid(),
		kind: specialistKindSchema,
	}),
	z.object({
		...jobEventBase,
		type: z.literal("tool-call"),
		stepId: z.uuid(),
		toolCallId: z.string().min(1),
		toolName: z.string().min(1),
		args: z.unknown(),
	}),
	z.object({
		...jobEventBase,
		type: z.literal("token"),
		stepId: z.uuid(),
		delta: z.string(),
	}),
	z.object({
		...jobEventBase,
		type: z.literal("completion"),
		stepId: z.uuid().optional(),
		result: specialistResultSchema.optional(),
	}),
	z.object({
		...jobEventBase,
		type: z.literal("error"),
		stepId: z.uuid().optional(),
		message: z.string().min(1),
		code: z.string().optional(),
	}),
]);

export type JobEvent = z.infer<typeof jobEventSchema>;

/** The event-type discriminants, for exhaustive DB enum / switch checks (R3.6). */
export const jobEventTypeSchema = z.enum([
	"step-start",
	"tool-call",
	"token",
	"completion",
	"error",
]);

export type JobEventType = z.infer<typeof jobEventTypeSchema>;
