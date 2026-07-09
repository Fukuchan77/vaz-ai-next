import type { AgentDeps } from "@vaz/schemas/deps";
import type {
	JobEvent,
	SpecialistResult,
	SupervisorPlan,
	WorkflowStepResult,
} from "@vaz/schemas/workflows";
import {
	buildWorkerDeps,
	createJobHandler,
	type DurableEngine,
	JOB_FUNCTION_CONFIG,
	JOB_REQUESTED_EVENT,
	type JobRequest,
	registerWorker,
	runJob,
	submitJob,
	type WorkerSpan,
	type WorkerTracer,
} from "../src/main";

/**
 * Task 13.2 — engine-agnostic worker entry.
 *
 * These tests exercise the WIRING (durable-step port, OTel span attribution,
 * web↔worker submission split, deps construction) with injected seams only:
 * no durable engine, no network, no LLM, no DB. The concrete Inngest client is
 * injected at the container edge (Task 13.5) and its live durability is proven
 * by the durable E2E (Task 15).
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "22222222-2222-4222-8222-222222222222";
const STEP_ID_2 = "33333333-3333-4333-8333-333333333333";

/** Deterministic deps: pinned clock, silent logger (ADR-3). */
function testDeps(): AgentDeps {
	const fixed = new Date("2026-07-07T00:00:00.000Z");
	return {
		db: null,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		now: () => fixed,
	};
}

/** A plan with a single data-processing step (overridable specialist, no LLM/DB). */
function dataPlan(): SupervisorPlan {
	return {
		goal: "process the payload",
		steps: [{ stepId: STEP_ID, task: { kind: "data-processing", operation: "noop", input: 1 } }],
	};
}

function request(plan: SupervisorPlan = dataPlan(), userId: string | null = "user-1"): JobRequest {
	return { jobId: JOB_ID, userId, plan };
}

/** A recording tracer seam capturing span names, attributes, and lifecycle. */
function recordingTracer(): {
	tracer: WorkerTracer;
	spans: Array<{
		name: string;
		attributes: Record<string, string | number | boolean>;
		ended: boolean;
		errored: string | null;
		exceptions: unknown[];
	}>;
} {
	const spans: Array<{
		name: string;
		attributes: Record<string, string | number | boolean>;
		ended: boolean;
		errored: string | null;
		exceptions: unknown[];
	}> = [];
	const tracer: WorkerTracer = {
		startSpan(name, attributes) {
			const record = {
				name,
				attributes: { ...(attributes ?? {}) },
				ended: false,
				errored: null as string | null,
				exceptions: [] as unknown[],
			};
			spans.push(record);
			const span: WorkerSpan = {
				setAttribute(key, value) {
					record.attributes[key] = value;
				},
				recordException(error) {
					record.exceptions.push(error);
				},
				setError(message) {
					record.errored = message;
				},
				end() {
					record.ended = true;
				},
			};
			return span;
		},
	};
	return { tracer, spans };
}

describe("runJob — step execution through the durable port (R3.1/3.2)", () => {
	test("dispatches the plan through the injected step runner and returns typed results", async () => {
		const seen: string[] = [];
		const results = await runJob(testDeps(), request(), {
			step: {
				run(stepId, fn) {
					seen.push(stepId);
					return fn();
				},
			},
			specialists: {
				"data-processing": async () => ({ kind: "data-processing", result: "done" }),
			},
		});

		// every plan step routed through the durable step port, correlated by stepId
		expect(seen).toEqual([STEP_ID]);
		expect(results).toHaveLength(1);
		expect(results[0]?.stepId).toBe(STEP_ID);
		expect(results[0]?.result).toEqual({ kind: "data-processing", result: "done" });
	});

	test("validates the job request and rejects a malformed plan", async () => {
		await expect(
			runJob(testDeps(), { jobId: JOB_ID, userId: null, plan: { goal: "", steps: [] } } as never),
		).rejects.toThrow();
	});
});

describe("runJob — OTel span attribution (R4.2)", () => {
	test("opens a job span carrying jobId + userId, and a step span carrying the agent name", async () => {
		const { tracer, spans } = recordingTracer();
		await runJob(testDeps(), request(), {
			tracer,
			specialists: {
				"data-processing": async () => ({ kind: "data-processing", result: "ok" }),
			},
		});

		const jobSpan = spans.find((s) => s.attributes.jobId === JOB_ID && s.attributes.userId);
		expect(jobSpan).toBeDefined();
		expect(jobSpan?.attributes.userId).toBe("user-1");
		expect(jobSpan?.ended).toBe(true);

		// each step's span carries jobId, userId, stepId, and the agent (specialist) name
		const stepSpan = spans.find((s) => s.attributes.stepId === STEP_ID);
		expect(stepSpan).toBeDefined();
		expect(stepSpan?.attributes.jobId).toBe(JOB_ID);
		expect(stepSpan?.attributes.userId).toBe("user-1");
		expect(stepSpan?.attributes.agent).toBe("data-processing");
		expect(stepSpan?.ended).toBe(true);
	});

	test("marks the job span errored and rethrows when a specialist fails (engine owns retry)", async () => {
		const { tracer, spans } = recordingTracer();
		await expect(
			runJob(testDeps(), request(), {
				tracer,
				specialists: {
					"data-processing": async () => {
						throw new Error("boom");
					},
				},
			}),
		).rejects.toThrow("boom");

		const jobSpan = spans.find((s) => s.attributes.jobId === JOB_ID && "userId" in s.attributes);
		expect(jobSpan?.errored).toBe("boom");
		expect(jobSpan?.ended).toBe(true);
	});

	test("forwards every JobEvent to the caller's emit sink unchanged", async () => {
		const events: JobEvent[] = [];
		await runJob(testDeps(), request(), {
			emit: (event) => {
				events.push(event);
			},
			specialists: {
				"data-processing": async () => ({ kind: "data-processing", result: "ok" }),
			},
		});
		expect(events.some((e) => e.type === "step-start" && e.stepId === STEP_ID)).toBe(true);
		expect(events.some((e) => e.type === "completion" && e.stepId === STEP_ID)).toBe(true);
		// job-level completion (no stepId) closes the stream
		expect(events.some((e) => e.type === "completion" && e.stepId === undefined)).toBe(true);
	});

	test("null userId is attributed as anonymous on the job span", async () => {
		const { tracer, spans } = recordingTracer();
		await runJob(testDeps(), request(dataPlan(), null), {
			tracer,
			specialists: { "data-processing": async () => ({ kind: "data-processing", result: "ok" }) },
		});
		const jobSpan = spans.find((s) => s.attributes.jobId === JOB_ID);
		expect(jobSpan?.attributes.userId).toBe("anonymous");
	});
});

describe("web↔worker decoupling (R3.2)", () => {
	test("submitJob sends a job/requested event, idempotent on the job's id", async () => {
		const sent: Array<{ name: string; data: JobRequest; id?: string }> = [];
		const engine: DurableEngine = {
			createFunction: () => ({}),
			send: async (payload) => {
				sent.push(payload);
			},
		};
		await submitJob(engine, request());
		expect(sent).toEqual([{ name: JOB_REQUESTED_EVENT, data: request(), id: JOB_ID }]);
	});

	test("registerWorker registers the job function under the fixed config + trigger", async () => {
		let captured:
			| {
					config: { id: string; retries?: number };
					trigger: { event: string };
					handler: (ctx: {
						event: { data: JobRequest };
						step: { run<T>(id: string, fn: () => Promise<T>): Promise<T> };
					}) => Promise<WorkflowStepResult[]>;
			  }
			| undefined;
		const engine: DurableEngine = {
			createFunction: (config, trigger, handler) => {
				captured = { config, trigger, handler };
				return { id: config.id };
			},
			send: async () => {},
		};

		registerWorker(engine, testDeps(), {
			specialists: { "data-processing": async () => ({ kind: "data-processing", result: "r" }) },
		});

		expect(captured?.config).toEqual(JOB_FUNCTION_CONFIG);
		expect(captured?.trigger).toEqual({ event: JOB_REQUESTED_EVENT });

		// the registered handler drives runJob when the engine invokes it
		const results = await captured?.handler({
			event: { data: request() },
			step: { run: (_id, fn) => fn() },
		});
		expect(results?.[0]?.result).toEqual({ kind: "data-processing", result: "r" });
	});

	test("createJobHandler routes the engine's durable step into the supervisor", async () => {
		const runIds: string[] = [];
		const handler = createJobHandler(testDeps(), {
			specialists: { "data-processing": async () => ({ kind: "data-processing", result: "z" }) },
		});
		const results = await handler({
			event: { data: request() },
			step: {
				run: (id, fn) => {
					runIds.push(id);
					return fn();
				},
			},
		});
		expect(runIds).toEqual([STEP_ID]);
		expect(results[0]?.result).toEqual({ kind: "data-processing", result: "z" });
	});
});

describe("buildWorkerDeps — composition-root deps (ADR-3)", () => {
	test("provides a real wall clock and a privacy-respecting logger by default", () => {
		const deps = buildWorkerDeps();
		expect(deps.now()).toBeInstanceOf(Date);
		expect(typeof deps.logger.info).toBe("function");
		expect(deps.db).toBeNull();
		expect(deps.audit).toBeUndefined();
	});

	test("injects db and audit overrides (worker supplies the DB sink, Task 13.4)", () => {
		const db = { select: () => ({}) };
		const record: Array<unknown> = [];
		const deps = buildWorkerDeps({ db, audit: { record: (e) => record.push(e) } });
		expect(deps.db).toBe(db);
		deps.audit?.record({ userId: null, jobId: JOB_ID, tool: "t", args: {}, ts: deps.now() });
		expect(record).toHaveLength(1);
	});

	test("multi-step plans dispatch in order through the durable port", async () => {
		const order: string[] = [];
		const plan: SupervisorPlan = {
			goal: "two steps",
			steps: [
				{ stepId: STEP_ID, task: { kind: "data-processing", operation: "a", input: 1 } },
				{ stepId: STEP_ID_2, task: { kind: "data-processing", operation: "b", input: 2 } },
			],
		};
		const result: SpecialistResult = { kind: "data-processing", result: "x" };
		const results = await runJob(buildWorkerDeps(), request(plan), {
			step: {
				run(stepId, fn) {
					order.push(stepId);
					return fn();
				},
			},
			specialists: { "data-processing": async () => result },
		});
		expect(order).toEqual([STEP_ID, STEP_ID_2]);
		expect(results.map((r) => r.stepId)).toEqual([STEP_ID, STEP_ID_2]);
	});
});
