import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import type { EmbedQuery, RetrievalMatch, RetrievalStore } from "@vaz/rag/retrieve/index";
import { createRetrievalCapability } from "@vaz/rag/tools";
import type { AgentDeps } from "@vaz/schemas/deps";
import type { Citation } from "@vaz/schemas/rag";
import type {
	JobEvent,
	SpecialistInput,
	SpecialistResult,
	SupervisorPlan,
} from "@vaz/schemas/workflows";
import { MockLanguageModelV4 } from "ai/test";
import {
	buildDocumentGenerationRuntimeContext,
	createSupervisorWorkflow,
	type SpecialistRegistry,
	SpecialistUnavailableError,
	type WorkflowStepRunner,
} from "../src/supervisor";

/**
 * Unit tests for `createSupervisorWorkflow` (R3.3): the supervisor PLANS and
 * DISPATCHES a {@link SupervisorPlan} to specialist agents as engine-agnostic
 * workflow steps, correlating typed results by `stepId`, threading the
 * rag-research → document-generation citation handoff, and emitting the
 * {@link JobEvent} progress union (R3.6). All network-free: specialists are the
 * primary seam (fakes for orchestration), and the built-in defaults are driven
 * by the RAG retrieval seam (fake store) and the `model` seam
 * (`MockLanguageModelV4`) — no DB, no LLM call, no engine import.
 */

const PINNED = new Date("2026-02-03T04:05:06.000Z");
const ISO = PINNED.toISOString();

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
/** Deps with a pinned clock so every `JobEvent.ts` is deterministic (ADR-3). */
const makeDeps = (db: unknown = null, overrides: Partial<AgentDeps> = {}): AgentDeps =>
	({ db, logger: silentLogger, now: () => PINNED, ...overrides }) as AgentDeps;

// Valid v4 UUIDs — `jobEventSchema`/`workflowStepSchema` fix these as `z.uuid()`.
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const S2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";
const CIT: Citation = { documentId: DOC_ID, source: "docs/a.md", chunkId: CHUNK_ID };

const dataStep = (stepId: string, operation: string, input: unknown) => ({
	stepId,
	task: { kind: "data-processing", operation, input } satisfies SpecialistInput,
});

describe("createSupervisorWorkflow — dispatch orchestration (R3.3)", () => {
	test("dispatches steps in order and correlates typed results by stepId", async () => {
		const calls: string[] = [];
		const specialists: Partial<SpecialistRegistry> = {
			"data-processing": async (task) => {
				calls.push(task.operation);
				return { kind: "data-processing", result: { echoed: task.operation } };
			},
		};
		const plan: SupervisorPlan = {
			goal: "process",
			steps: [dataStep(S1, "op1", { a: 1 }), dataStep(S2, "op2", { b: 2 })],
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists });
		const results = await wf.dispatch(plan, { jobId: JOB });

		expect(calls).toEqual(["op1", "op2"]); // in-order dispatch
		expect(results).toEqual([
			{ stepId: S1, result: { kind: "data-processing", result: { echoed: "op1" } } },
			{ stepId: S2, result: { kind: "data-processing", result: { echoed: "op2" } } },
		]);
	});

	test("emits step-start + per-step completion + a final job-level completion (R3.6)", async () => {
		const specialists: Partial<SpecialistRegistry> = {
			"data-processing": async (task) => ({ kind: "data-processing", result: task.operation }),
		};
		const plan: SupervisorPlan = {
			goal: "process",
			steps: [dataStep(S1, "op1", 1), dataStep(S2, "op2", 2)],
		};
		const events: JobEvent[] = [];

		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists,
			emit: (e) => {
				events.push(e);
			},
		});
		await wf.dispatch(plan, { jobId: JOB });

		expect(events.map((e) => e.type)).toEqual([
			"step-start",
			"completion",
			"step-start",
			"completion",
			"completion",
		]);
		// Every event carries the jobId and the pinned wire timestamp (deps.now, ADR-3).
		expect(events.every((e) => e.jobId === JOB && e.ts === ISO)).toBe(true);
		expect(events[0]).toMatchObject({ type: "step-start", stepId: S1, kind: "data-processing" });
		expect(events[1]).toMatchObject({
			type: "completion",
			stepId: S1,
			result: { kind: "data-processing", result: "op1" },
		});
		// The final event is job-level completion: no stepId, no result.
		const last = events[4];
		expect(last.type).toBe("completion");
		expect(last.type === "completion" && last.stepId).toBeUndefined();
	});

	test("routes each step through the injected durable-step runner with its stepId", async () => {
		const runCalls: string[] = [];
		const step: WorkflowStepRunner = {
			run: (stepId, fn) => {
				runCalls.push(stepId);
				return fn();
			},
		};
		const specialists: Partial<SpecialistRegistry> = {
			"data-processing": async () => ({ kind: "data-processing", result: null }),
		};
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [dataStep(S1, "op1", 1), dataStep(S2, "op2", 2)],
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists, step });
		await wf.dispatch(plan, { jobId: JOB });

		expect(runCalls).toEqual([S1, S2]);
	});
});

describe("createSupervisorWorkflow — citation handoff (R3.3)", () => {
	test("threads rag-research citations into a later document-generation step lacking its own", async () => {
		let received: Citation[] | undefined;
		const specialists: Partial<SpecialistRegistry> = {
			"rag-research": async () => ({ kind: "rag-research", findings: "f", citations: [CIT] }),
			"document-generation": async (task) => {
				received = task.citations;
				return {
					kind: "document-generation",
					document: { title: "T", format: task.format, content: "c" },
				};
			},
		};
		const plan: SupervisorPlan = {
			goal: "research then write",
			steps: [
				{ stepId: S1, task: { kind: "rag-research", query: "q" } },
				{
					stepId: S2,
					task: { kind: "document-generation", instructions: "write", format: "markdown" },
				},
			],
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists });
		await wf.dispatch(plan, { jobId: JOB });

		expect(received).toEqual([CIT]);
	});

	test("does not override a document-generation step that already carries citations", async () => {
		const OWN: Citation = { ...CIT, source: "docs/own.md" };
		let received: Citation[] | undefined;
		const specialists: Partial<SpecialistRegistry> = {
			"rag-research": async () => ({ kind: "rag-research", findings: "f", citations: [CIT] }),
			"document-generation": async (task) => {
				received = task.citations;
				return {
					kind: "document-generation",
					document: { title: "T", format: task.format, content: "c" },
				};
			},
		};
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [
				{ stepId: S1, task: { kind: "rag-research", query: "q" } },
				{
					stepId: S2,
					task: {
						kind: "document-generation",
						instructions: "write",
						format: "markdown",
						citations: [OWN],
					},
				},
			],
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists });
		await wf.dispatch(plan, { jobId: JOB });

		expect(received).toEqual([OWN]);
	});

	test("does not leak a consumed handoff into a LATER, unrelated document-generation step", async () => {
		const CIT_B: Citation = { ...CIT, documentId: "33333333-3333-4333-8333-333333333333" };
		const S3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const S4 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		const received: Array<Citation[] | undefined> = [];
		let researchCall = 0;
		const specialists: Partial<SpecialistRegistry> = {
			"rag-research": async () => {
				researchCall += 1;
				return {
					kind: "rag-research",
					findings: "f",
					citations: [researchCall === 1 ? CIT : CIT_B],
				};
			},
			"document-generation": async (task) => {
				received.push(task.citations);
				return {
					kind: "document-generation",
					document: { title: "T", format: task.format, content: "c" },
				};
			},
		};
		const plan: SupervisorPlan = {
			goal: "research/write, research/write",
			steps: [
				{ stepId: S1, task: { kind: "rag-research", query: "q1" } },
				{
					stepId: S2,
					task: { kind: "document-generation", instructions: "write 1", format: "markdown" },
				},
				{ stepId: S3, task: { kind: "rag-research", query: "q2" } },
				{
					stepId: S4,
					task: { kind: "document-generation", instructions: "write 2", format: "markdown" },
				},
			],
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists });
		await wf.dispatch(plan, { jobId: JOB });

		expect(received).toEqual([[CIT], [CIT_B]]); // the second generation must NOT also receive CIT
	});

	test("still accumulates citations across consecutive rag-research steps before a single consuming generation step", async () => {
		const CIT_B: Citation = { ...CIT, documentId: "33333333-3333-4333-8333-333333333333" };
		const S3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		let received: Citation[] | undefined;
		let researchCall = 0;
		const specialists: Partial<SpecialistRegistry> = {
			"rag-research": async () => {
				researchCall += 1;
				return {
					kind: "rag-research",
					findings: "f",
					citations: [researchCall === 1 ? CIT : CIT_B],
				};
			},
			"document-generation": async (task) => {
				received = task.citations;
				return {
					kind: "document-generation",
					document: { title: "T", format: task.format, content: "c" },
				};
			},
		};
		const plan: SupervisorPlan = {
			goal: "research, research, then write",
			steps: [
				{ stepId: S1, task: { kind: "rag-research", query: "q1" } },
				{ stepId: S2, task: { kind: "rag-research", query: "q2" } },
				{
					stepId: S3,
					task: { kind: "document-generation", instructions: "write", format: "markdown" },
				},
			],
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists });
		await wf.dispatch(plan, { jobId: JOB });

		expect(received).toEqual([CIT, CIT_B]);
	});
});

describe("createSupervisorWorkflow — error handling", () => {
	test("emits an error event and rethrows when a specialist fails (engine owns retry/resume)", async () => {
		const specialists: Partial<SpecialistRegistry> = {
			"data-processing": async () => {
				throw new Error("boom");
			},
		};
		const events: JobEvent[] = [];
		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists,
			emit: (e) => {
				events.push(e);
			},
		});

		await expect(
			wf.dispatch({ goal: "g", steps: [dataStep(S1, "op1", 1)] }, { jobId: JOB }),
		).rejects.toThrow("boom");

		const errEvent = events.find((e) => e.type === "error");
		expect(errEvent).toMatchObject({ type: "error", stepId: S1, jobId: JOB, message: "boom" });
		// A failed run does not emit the job-level completion.
		expect(events.some((e) => e.type === "completion" && !e.stepId)).toBe(false);
	});
});

// --- Built-in default specialists (network-free via the retrieval + model seams) ---

const fakeEmbedQuery: EmbedQuery = async () => new Array<number>(EMBEDDING_DIM).fill(0);
class FakeStore implements RetrievalStore {
	matches: RetrievalMatch[] = [];
	async searchByVector() {
		return this.matches;
	}
}
const fakeRetrieval = (matches: RetrievalMatch[]) => {
	const store = new FakeStore();
	store.matches = matches;
	return createRetrievalCapability(makeDeps(), { store, embedQuery: fakeEmbedQuery });
};

describe("createSupervisorWorkflow — default specialists", () => {
	test("default rag-research synthesizes findings + citations from the retrieval capability", async () => {
		const retrieval = fakeRetrieval([
			{
				chunkId: CHUNK_ID,
				documentId: DOC_ID,
				source: "docs/onboarding.md",
				ordinal: 0,
				content: "New hires finish security training in week one.",
				distance: 0.1,
			},
		]);

		const wf = createSupervisorWorkflow(makeDeps(), { retrieval });
		const results = await wf.dispatch(
			{ goal: "g", steps: [{ stepId: S1, task: { kind: "rag-research", query: "q" } }] },
			{ jobId: JOB },
		);

		const result = results[0]?.result as Extract<SpecialistResult, { kind: "rag-research" }>;
		expect(result.kind).toBe("rag-research");
		expect(result.citations).toEqual([
			{ documentId: DOC_ID, source: "docs/onboarding.md", chunkId: CHUNK_ID },
		]);
		expect(result.findings).toContain("security training");
	});

	test("default rag-research explicitly records an audit entry (R5.5) — bypasses the SDK tool loop, so the lifecycle hook never fires for it", async () => {
		const retrieval = fakeRetrieval([
			{
				chunkId: CHUNK_ID,
				documentId: DOC_ID,
				source: "docs/onboarding.md",
				ordinal: 0,
				content: "New hires finish security training in week one.",
				distance: 0.1,
			},
		]);
		const recorded: Array<{
			userId: string | null;
			jobId: string | null;
			tool: string;
			args: unknown;
			ts: Date;
		}> = [];
		const audit = { record: async (entry: (typeof recorded)[number]) => recorded.push(entry) };
		const deps = makeDeps(null, { audit, runtimeContext: { userId: "user-1", role: "member" } });

		const wf = createSupervisorWorkflow(deps, { retrieval });
		await wf.dispatch(
			{ goal: "g", steps: [{ stepId: S1, task: { kind: "rag-research", query: "q" } }] },
			{ jobId: JOB },
		);

		expect(recorded).toEqual([
			{
				userId: "user-1",
				jobId: JOB,
				tool: "searchDocuments",
				args: { query: "q", topK: undefined },
				ts: PINNED,
			},
		]);
	});

	test("default rag-research is a no-op audit when deps.audit is omitted (Phase 1 allowed)", async () => {
		const retrieval = fakeRetrieval([
			{
				chunkId: CHUNK_ID,
				documentId: DOC_ID,
				source: "docs/onboarding.md",
				ordinal: 0,
				content: "content",
				distance: 0.1,
			},
		]);

		const wf = createSupervisorWorkflow(makeDeps(), { retrieval });
		await expect(
			wf.dispatch(
				{ goal: "g", steps: [{ stepId: S1, task: { kind: "rag-research", query: "q" } }] },
				{ jobId: JOB },
			),
		).resolves.toBeDefined();
	});

	test("default document-generation generates via the model seam, preserving format", async () => {
		const model = new MockLanguageModelV4({
			doGenerate: {
				content: [{ type: "text", text: "# Generated\n本文" }],
				finishReason: { unified: "stop", raw: undefined },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
					outputTokens: { total: 1, text: 1, reasoning: undefined },
				},
				warnings: [],
			},
		});

		const wf = createSupervisorWorkflow(makeDeps(), { model });
		const results = await wf.dispatch(
			{
				goal: "g",
				steps: [
					{
						stepId: S2,
						task: {
							kind: "document-generation",
							instructions: "Write the onboarding guide",
							format: "html",
							citations: [CIT],
						},
					},
				],
			},
			{ jobId: JOB },
		);

		const result = results[0]?.result as Extract<SpecialistResult, { kind: "document-generation" }>;
		expect(result.kind).toBe("document-generation");
		expect(result.document.content).toBe("# Generated\n本文");
		expect(result.document.format).toBe("html");
		expect(model.doGenerateCalls).toHaveLength(1);
	});

	test("default rag-research throws SpecialistUnavailableError without a datastore", async () => {
		const wf = createSupervisorWorkflow(makeDeps(/* db: null */));
		await expect(
			wf.dispatch(
				{ goal: "g", steps: [{ stepId: S1, task: { kind: "rag-research", query: "q" } }] },
				{ jobId: JOB },
			),
		).rejects.toBeInstanceOf(SpecialistUnavailableError);
	});

	test("default data-processing throws SpecialistUnavailableError unless overridden", async () => {
		const wf = createSupervisorWorkflow(makeDeps());
		await expect(
			wf.dispatch({ goal: "g", steps: [dataStep(S1, "op", 1)] }, { jobId: JOB }),
		).rejects.toThrow(/data-processing/);
	});
});

describe("createSupervisorWorkflow — specialist dispatch context (R4.2)", () => {
	test("invoke passes the dispatch's jobId as a second ctx argument to the specialist", async () => {
		const seen: Array<{ jobId: string } | undefined> = [];
		const specialists: Partial<SpecialistRegistry> = {
			"document-generation": async (_input, ctx) => {
				seen.push(ctx);
				return {
					kind: "document-generation",
					document: { title: "t", format: "md", content: "c" },
				};
			},
		};

		const wf = createSupervisorWorkflow(makeDeps(), { specialists });
		await wf.dispatch(
			{
				goal: "g",
				steps: [
					{
						stepId: S1,
						task: { kind: "document-generation", instructions: "x", format: "md" },
					},
				],
			},
			{ jobId: JOB },
		);

		expect(seen).toEqual([{ jobId: JOB }]);
	});

	test("buildDocumentGenerationRuntimeContext(jobId) shapes the R4.2 telemetry context", () => {
		expect(buildDocumentGenerationRuntimeContext(JOB)).toEqual({
			jobId: JOB,
			agentName: "document-generation",
		});
	});
});
