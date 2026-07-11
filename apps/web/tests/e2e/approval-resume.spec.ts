import { expect, test } from "@playwright/test";
import type { Logger } from "@vaz/schemas/deps";
import type {
	JobEvent,
	SpecialistInput,
	SupervisorPlan,
	WorkflowStepResult,
} from "@vaz/schemas/workflows";
import {
	APPROVAL_EVENT,
	type ApprovalDecision,
	type ApprovalGate,
	type ApprovalSignal,
	type DurableEngine,
	JOB_REQUESTED_EVENT,
	type JobFunctionContext,
	type JobRequest,
	registerWorker,
	submitApproval,
	submitJob,
} from "@vaz/worker/src/main";

/**
 * Durable E2E for HITL suspend → (day-later) approval → resume → complete
 * (R3.5/R3.7/R3.8).
 *
 * SCOPE / FIDELITY (read before touching this file):
 *
 * The "real" path is `POST /api/jobs` / `GET /api/jobs/:id/stream` /
 * `POST /api/jobs/:id/approve` over a live Postgres + Redis + Inngest +
 * `apps/worker` stack (`docker-compose.yml`), which needs a Docker daemon.
 * Independently of Docker, production wiring never actually activates
 * `requiresApproval` today: `apps/worker/src/start.ts` calls
 * `registerJobFunction(engine, deps, { emit })` with no `requiresApproval`/
 * `approvalGate`. A step-identity–keyed predicate (`(stepId: string) =>
 * boolean`) is also inherently static per-process, not derivable per-job from
 * the wire contract as it stands (`workflowStepSchema` carries no "requires
 * approval" flag) — closing that for real is a cross-cutting change to
 * `@vaz/schemas/workflows` + `apps/worker/src/main.ts`.
 *
 * So this spec proves the mechanism at the layer directly below the HTTP
 * routes: it calls the exact same, unmodified engine-binding functions the
 * routes call — `registerWorker`/`submitJob`/`submitApproval` from
 * `apps/worker/src/main.ts` — against a minimal in-memory fake `DurableEngine`
 * implementing the identical structural port Inngest satisfies
 * (`createFunction`/`send`, see `main.ts`'s `DurableEngine` doc comment). No
 * production file changes; this file is the entire boundary.
 *
 * This is deliberately NOT a re-run of `durability.spec.ts` (which already
 * unit-tests `runJob`/`createDurableStepRunner` directly — restart replay +
 * approval suspend/resume). The layer that unit test does NOT cover is the
 * `DurableEngine.createFunction`/`.send()` binding itself — i.e. whether a job
 * submitted the way `POST /api/jobs` submits it, and approved the way
 * `POST /api/jobs/:id/approve` approves it, actually round-trips through
 * suspend/resume end to end. That is what this spec adds.
 *
 * "Approved the next day" (R3.8) is proven via the ADR-3 injected clock
 * (`deps.now`): the suspend itself is a plain unresolved Promise (faithful to
 * `step.waitForEvent`'s real suspend semantics — nothing time-based holds it
 * open), and the clock is advanced by 24h before the approval event arrives,
 * so the emitted `JobEvent` timestamps demonstrably span a full day.
 *
 * The worker-restart-crossing scenario (R3.7) is included below because the
 * harness makes it a small, non-redundant addition at the `DurableEngine`
 * layer (the unit test never calls `registerWorker`/`submitJob`).
 */

const JOB_ID_NEXT_DAY = "55555555-5555-4555-8555-555555555555";
const STEP_PREPARE = "66666666-6666-4666-8666-666666666666";
const STEP_DESTRUCTIVE = "77777777-7777-4777-8777-777777777777";

const JOB_ID_RESTART = "88888888-8888-4888-8888-888888888888";
const STEP_PREPARE_2 = "99999999-9999-4999-8999-999999999999";
const STEP_DESTRUCTIVE_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const noopLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
};

function dataProcessingTask(operation: string): SpecialistInput {
	return { kind: "data-processing", operation, input: null };
}

function twoStepPlan(prepareStepId: string, destructiveStepId: string): SupervisorPlan {
	return {
		goal: "prepare then run a destructive step",
		steps: [
			{ stepId: prepareStepId, task: dataProcessingTask("prepare") },
			{ stepId: destructiveStepId, task: dataProcessingTask("send-email") },
		],
	};
}

/** Records one call per `operation` so tests can assert exactly-once execution. */
function countingDataProcessingSpecialist(calls: Map<string, number>) {
	return {
		"data-processing": async (input: Extract<SpecialistInput, { kind: "data-processing" }>) => {
			calls.set(input.operation, (calls.get(input.operation) ?? 0) + 1);
			return { kind: "data-processing" as const, result: `done:${input.operation}` };
		},
	};
}

/** A clock (ADR-3 `Clock`) whose reading can be advanced deterministically, so
 * "approved the next day" is proven without a real 24h sleep in CI. */
function createControllableClock(initial: Date) {
	let current = initial;
	return {
		now: () => current,
		advanceHours(hours: number) {
			current = new Date(current.getTime() + hours * 60 * 60 * 1000);
		},
	};
}

/**
 * A minimal in-memory `DurableEngine` (the structural port `main.ts` requires
 * and Inngest satisfies): `createFunction` registers the worker's job
 * handler; `send` dispatches `job/requested` (invoking the handler with a
 * checkpointing `step` + a suspend-until-correlated-event `waitForApproval`)
 * and `job/approval` (resolving whichever `waitForApproval` call is currently
 * pending for that `jobId`+`stepId`).
 *
 * The checkpoint map lives on the ENGINE (not per-invocation), mirroring real
 * Inngest: step results are persisted server-side, so re-dispatching the same
 * `jobId` (the "restart" scenario) replays completed steps from that same map
 * without re-invoking their specialist.
 */
function createFakeDurableEngine() {
	type Handler = (ctx: JobFunctionContext) => Promise<WorkflowStepResult[]>;
	let handler: Handler | null = null;
	const checkpointsByJob = new Map<string, Map<string, unknown>>();
	const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();

	function checkpointsFor(jobId: string): Map<string, unknown> {
		let memo = checkpointsByJob.get(jobId);
		if (!memo) {
			memo = new Map();
			checkpointsByJob.set(jobId, memo);
		}
		return memo;
	}

	const engine: DurableEngine = {
		createFunction(_config, _trigger, fn) {
			handler = fn;
			return fn;
		},
		send(payload) {
			if (payload.name === JOB_REQUESTED_EVENT) {
				if (!handler) throw new Error("No job function registered on the fake engine");
				const request = payload.data as JobRequest;
				const memo = checkpointsFor(request.jobId);
				const step: JobFunctionContext["step"] = {
					async run<T>(stepId: string, fn: () => Promise<T>): Promise<T> {
						if (memo.has(stepId)) return memo.get(stepId) as T;
						const result = await fn();
						memo.set(stepId, result);
						return result;
					},
				};
				const waitForApproval: ApprovalGate = ({ jobId, stepId }) =>
					new Promise((resolve) => {
						pendingApprovals.set(`${jobId}:${stepId}`, resolve);
					});
				return handler({ event: { data: request }, step, waitForApproval });
			}
			if (payload.name === APPROVAL_EVENT) {
				const signal = payload.data as ApprovalSignal;
				const key = `${signal.jobId}:${signal.stepId}`;
				const resolve = pendingApprovals.get(key);
				pendingApprovals.delete(key);
				resolve?.({ approved: signal.approved, args: signal.args });
				return undefined;
			}
			throw new Error(`Unexpected event on the fake engine: ${String(payload.name)}`);
		},
	};

	return engine;
}

test.describe("approval interrupt → day-later approval → resume completes (R3.5/R3.8)", () => {
	test("a destructive step suspends for approval and resumes to completion after a simulated day", async () => {
		const engine = createFakeDurableEngine();
		const clock = createControllableClock(new Date("2026-07-09T09:00:00.000Z"));
		const calls = new Map<string, number>();
		const events: JobEvent[] = [];

		registerWorker(
			engine,
			{ db: null, logger: noopLogger, now: clock.now },
			{
				emit: (event) => {
					events.push(event);
				},
				requiresApproval: (stepId) => stepId === STEP_DESTRUCTIVE,
				approvalTimeout: "7d",
				specialists: countingDataProcessingSpecialist(calls),
			},
		);

		const request: JobRequest = {
			jobId: JOB_ID_NEXT_DAY,
			userId: null,
			plan: twoStepPlan(STEP_PREPARE, STEP_DESTRUCTIVE),
		};
		const jobPromise = submitJob(engine, request) as Promise<WorkflowStepResult[]>;

		// The non-destructive step runs to completion; the destructive step
		// suspends before its specialist ever runs (R3.4).
		await expect
			.poll(() => events.some((e) => e.type === "step-start" && e.stepId === STEP_DESTRUCTIVE))
			.toBe(true);
		expect(events.some((e) => e.type === "completion" && e.stepId === STEP_DESTRUCTIVE)).toBe(
			false,
		);
		expect(calls.get("prepare")).toBe(1);
		expect(calls.get("send-email")).toBeUndefined();

		const suspendedAt = events.find(
			(e) => e.type === "step-start" && e.stepId === STEP_DESTRUCTIVE,
		)?.ts;

		// R3.8: the approval arrives a simulated day later — nothing about the
		// suspend depends on real elapsed time, only on when the approval event
		// arrives (`step.waitForEvent`'s real semantics).
		clock.advanceHours(24);
		await submitApproval(engine, {
			jobId: JOB_ID_NEXT_DAY,
			stepId: STEP_DESTRUCTIVE,
			approved: true,
		});

		const results = await jobPromise;

		expect(results.map((r) => r.stepId)).toEqual([STEP_PREPARE, STEP_DESTRUCTIVE]);
		expect(calls.get("prepare")).toBe(1);
		expect(calls.get("send-email")).toBe(1);

		const completedDestructive = events.find(
			(e) => e.type === "completion" && e.stepId === STEP_DESTRUCTIVE,
		);
		expect(completedDestructive).toBeDefined();
		expect(suspendedAt).toBeDefined();
		const elapsedMs =
			new Date(completedDestructive?.ts as string).getTime() -
			new Date(suspendedAt as string).getTime();
		expect(elapsedMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);

		// The job-level completion (no stepId) closes out the event stream (R3.6).
		const finalEvent = events.at(-1);
		expect(finalEvent?.type).toBe("completion");
		expect(finalEvent && "stepId" in finalEvent ? finalEvent.stepId : undefined).toBeUndefined();
	});

	test("a rejected approval denies the destructive step without running it", async () => {
		const engine = createFakeDurableEngine();
		const calls = new Map<string, number>();
		const events: JobEvent[] = [];

		registerWorker(
			engine,
			{ db: null, logger: noopLogger, now: () => new Date("2026-07-09T09:00:00.000Z") },
			{
				emit: (event) => {
					events.push(event);
				},
				requiresApproval: (stepId) => stepId === STEP_DESTRUCTIVE,
				specialists: countingDataProcessingSpecialist(calls),
			},
		);

		const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const request: JobRequest = {
			jobId,
			userId: null,
			plan: twoStepPlan(STEP_PREPARE, STEP_DESTRUCTIVE),
		};
		const jobPromise = submitJob(engine, request) as Promise<WorkflowStepResult[]>;

		await expect
			.poll(() => events.some((e) => e.type === "step-start" && e.stepId === STEP_DESTRUCTIVE))
			.toBe(true);

		await submitApproval(engine, { jobId, stepId: STEP_DESTRUCTIVE, approved: false });

		await expect(jobPromise).rejects.toMatchObject({
			name: "ApprovalDeniedError",
			stepId: STEP_DESTRUCTIVE,
			reason: "rejected",
		});
		expect(calls.get("send-email")).toBeUndefined();
	});
});

test.describe("approval interrupt survives a worker restart (R3.7)", () => {
	test("a suspended job resumes and completes across a simulated worker restart without re-running completed steps", async () => {
		const engine = createFakeDurableEngine();
		const calls = new Map<string, number>();
		const events: JobEvent[] = [];

		registerWorker(
			engine,
			{ db: null, logger: noopLogger, now: () => new Date("2026-07-09T09:00:00.000Z") },
			{
				emit: (event) => {
					events.push(event);
				},
				requiresApproval: (stepId) => stepId === STEP_DESTRUCTIVE_2,
				specialists: countingDataProcessingSpecialist(calls),
			},
		);

		const request: JobRequest = {
			jobId: JOB_ID_RESTART,
			userId: null,
			plan: twoStepPlan(STEP_PREPARE_2, STEP_DESTRUCTIVE_2),
		};

		// Attempt 1 ("before the crash"): the non-destructive step checkpoints on
		// the engine; the destructive step suspends and is deliberately left
		// unresolved — a real crash would simply kill the worker process here.
		// Not awaited: nothing ever settles this promise.
		void submitJob(engine, request);
		await expect
			.poll(
				() =>
					events.filter((e) => e.type === "step-start" && e.stepId === STEP_DESTRUCTIVE_2).length,
			)
			.toBe(1);
		expect(calls.get("prepare")).toBe(1);

		// "Restart": Inngest re-invokes the same durable function for the same
		// job on worker reconnect. The engine (not the worker) owns the
		// checkpoint, so the already-completed step must replay from it — its
		// specialist must NOT run again.
		const resumedPromise = submitJob(engine, request) as Promise<WorkflowStepResult[]>;
		await expect
			.poll(
				() =>
					events.filter((e) => e.type === "step-start" && e.stepId === STEP_DESTRUCTIVE_2).length,
			)
			.toBe(2);
		expect(calls.get("prepare")).toBe(1); // still 1 — the replay did not re-execute it

		await submitApproval(engine, {
			jobId: JOB_ID_RESTART,
			stepId: STEP_DESTRUCTIVE_2,
			approved: true,
		});
		const results = await resumedPromise;

		expect(results.map((r) => r.stepId)).toEqual([STEP_PREPARE_2, STEP_DESTRUCTIVE_2]);
		expect(calls.get("prepare")).toBe(1);
		expect(calls.get("send-email")).toBe(1);
	});
});
