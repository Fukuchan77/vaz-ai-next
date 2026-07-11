import {
	type CreateSupervisorWorkflowOptions,
	createSupervisorWorkflow,
	type JobEventSink,
	type WorkflowStepRunner,
} from "@vaz/agents/supervisor";
import type { AgentDeps, AuditSink, Logger } from "@vaz/schemas/deps";
import {
	type SupervisorPlan,
	supervisorPlanSchema,
	type WorkflowStepResult,
} from "@vaz/schemas/workflows";
import type { JobStore } from "./stores";

/**
 * `apps/worker` — the long-running Node 24 worker entry (R3.1/3.2/4.2).
 *
 * WHAT THIS OWNS: the engine's worker entry (job function registration + step
 * execution), the web↔worker submission split, and OTel span attribution
 * (jobId / userId / agent name) around every job and step.
 *
 * ENGINE-AGNOSTIC (ADR-2, spike §9/§10). The Phase 3 spike selected **Inngest**
 * (`docs/spikes/phase3-durable-engine.md`), but — exactly like the supervisor —
 * this module never imports the engine SDK. Durability arrives through the
 * {@link WorkflowStepRunner} port (Inngest `step.run` satisfies it structurally)
 * and the engine itself through the {@link DurableEngine} seam (matching
 * Inngest's `createFunction` / `send`). The concrete `new Inngest(...)` client,
 * the `inngest` dependency, and the Connect bootstrap are provisioned at the
 * container edge (Task 13.5) where the engine is actually runnable — the Task
 * 8.1 environment FLAG (no Docker → no Postgres/Redis/engine) blocks running it
 * now, and live durability (restart-crossing, day-later approval) is proven by
 * the durable E2E (Task 15). Swapping the engine never touches this file.
 *
 * ADR-3: runtime concerns are injected via {@link AgentDeps}. This module is the
 * composition root, so it is the one place that instantiates the real wall
 * clock ({@link buildWorkerDeps}); everything downstream reads `deps.now()`.
 */

/** Inngest event name for job submission (web → engine → worker). */
export const JOB_REQUESTED_EVENT = "job/requested" as const;

/** Inngest event name for an approval decision (web approval UI → engine → resume). */
export const APPROVAL_EVENT = "job/approval" as const;

/** Default approval-wait window (spike R3.8: a job may be approved the next day). */
export const DEFAULT_APPROVAL_TIMEOUT = "7d" as const;

/**
 * Durable job function config. `retries: 3` mirrors the spike sketch (§3); the
 * engine owns retry/resume, so a specialist failure simply rejects the step.
 */
export const JOB_FUNCTION_CONFIG = { id: "run-job", retries: 3 } as const;

/**
 * The worker's event payload (R3.2 typed handoff): a durable `jobId`, the
 * submitting `userId` (null when unauthenticated — auth lands in Phase 5), and
 * the supervisor {@link SupervisorPlan} to dispatch. Kept as the worker-side
 * contract here; `POST /api/jobs` (Task 14.1) validates the web-side submission.
 */
export interface JobRequest {
	jobId: string;
	userId: string | null;
	plan: SupervisorPlan;
}

/* -------------------------------------------------------------------------- */
/* OTel span seam (R4.2)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimal OTel-shaped span. Kept structural (like the engine seam) so this
 * module needs no `@opentelemetry/api` dependency: the container edge (Task
 * 13.5) adapts a real OTel `Span` — `setAttribute` / `recordException` /
 * `setStatus(ERROR)` / `end` map 1:1.
 */
export interface WorkerSpan {
	setAttribute(key: string, value: string | number | boolean): void;
	recordException(error: unknown): void;
	/** Mark the span failed (maps to OTel `setStatus({ code: ERROR, message })`). */
	setError(message: string): void;
	end(): void;
}

/** Span factory seam. Default is {@link noopTracer}; Task 13.5 injects OTel. */
export interface WorkerTracer {
	startSpan(name: string, attributes?: Record<string, string | number | boolean>): WorkerSpan;
}

const noopSpan: WorkerSpan = {
	setAttribute() {},
	recordException() {},
	setError() {},
	end() {},
};

/** No-op tracer: the default when no OTel tracer is injected (fail-soft, R4.3). */
export const noopTracer: WorkerTracer = { startSpan: () => noopSpan };

/* -------------------------------------------------------------------------- */
/* Durable engine seam (Inngest, structural)                                  */
/* -------------------------------------------------------------------------- */

/** Handler context the engine supplies per job (Inngest `{ event, step }`). */
export interface JobFunctionContext {
	event: { data: JobRequest };
	/** Durable step port — Inngest `step.run(id, fn)` satisfies this. */
	step: WorkflowStepRunner;
	/**
	 * Durable approval-await (Inngest `step.waitForEvent` adapter). When the
	 * engine supplies it, {@link createJobHandler} uses it as the {@link ApprovalGate}
	 * so a destructive step suspends until an {@link APPROVAL_EVENT} arrives.
	 */
	waitForApproval?: ApprovalGate;
}

/**
 * Structural view of the durable engine (Inngest). The container edge (Task
 * 13.5) passes a real `new Inngest(...)` here; keeping it structural means this
 * module — the anti-lock-in boundary — never imports the SDK.
 */
export interface DurableEngine {
	createFunction(
		config: { id: string; retries?: number },
		trigger: { event: string },
		handler: (ctx: JobFunctionContext) => Promise<WorkflowStepResult[]>,
	): unknown;
	send(payload: {
		name: string;
		data: JobRequest | ApprovalSignal;
		/** Idempotency key (Inngest `EventPayload.id`): re-sending the same id never re-invokes the function. */
		id?: string;
	}): Promise<unknown> | unknown;
}

/* -------------------------------------------------------------------------- */
/* Checkpoint durability + HITL approval (R3.5 / R3.7)                        */
/* -------------------------------------------------------------------------- */

/**
 * An approval decision returned by the {@link ApprovalGate}: `approved` gates
 * the destructive step; optional `args` carries edited tool arguments from the
 * approval UI (R3.4 "edit arguments"). `null` from the gate means the wait timed
 * out (no decision within the window).
 */
export interface ApprovalDecision {
	approved: boolean;
	args?: unknown;
}

/**
 * Durable approval-await seam (Inngest `step.waitForEvent`, correlated by
 * `jobId`, bounded by `timeout`). Suspends the workflow until an approval event
 * arrives; resolves `null` on timeout. Because the gate is itself run through
 * the checkpointing step port, a resolved decision is memoized — a resume after
 * a restart replays it rather than re-prompting (R3.5).
 */
export type ApprovalGate = (input: {
	jobId: string;
	stepId: string;
	timeout?: string;
}) => Promise<ApprovalDecision | null>;

/**
 * The approval signal sent from the web approval UI (Task 14.3) via
 * {@link submitApproval}, resuming the suspended workflow (R3.5).
 */
export interface ApprovalSignal {
	jobId: string;
	stepId: string;
	approved: boolean;
	args?: unknown;
}

/** Why a step's approval gate denied execution. */
export type ApprovalDeniedReason = "rejected" | "expired" | "misconfigured";

/**
 * Thrown by {@link createDurableStepRunner} when a step requiring approval is
 * not cleared to run: the user rejected it, the wait expired, or no gate was
 * configured (fail-closed). Carries `stepId` + `reason` so the approval UI /
 * job consumer can render a terminal state instead of a generic error.
 */
export class ApprovalDeniedError extends Error {
	readonly stepId: string;
	readonly reason: ApprovalDeniedReason;
	constructor(stepId: string, reason: ApprovalDeniedReason) {
		super(`Approval ${reason} for step "${stepId}".`);
		this.name = "ApprovalDeniedError";
		this.stepId = stepId;
		this.reason = reason;
	}
}

/** In-process step runner: run immediately, no durability (test / no-engine default). */
const DIRECT_STEP_RUNNER: WorkflowStepRunner = { run: (_stepId, fn) => fn() };

/** Options for {@link createDurableStepRunner}. */
export interface CreateDurableStepRunnerOptions {
	jobId: string;
	/** Predicate marking a step destructive → must be approved before it runs (R3.4). */
	requiresApproval?: (stepId: string) => boolean;
	/** Durable approval-await; required for any step where `requiresApproval` is true. */
	approvalGate?: ApprovalGate;
	/** Approval-wait window (default {@link DEFAULT_APPROVAL_TIMEOUT}). */
	approvalTimeout?: string;
}

/**
 * Wrap the engine's durable step port so that, before a step flagged by
 * `requiresApproval`, the workflow suspends awaiting approval (R3.5) — and only
 * then runs the checkpointed step. The approval-await is called directly
 * (NOT wrapped in `engineStep.run`): `approvalGate` is itself backed by a
 * durable primitive (Inngest `step.waitForEvent`, keyed by `await-approval:
 * <stepId>` — see `apps/worker/src/inngest.ts`) that the engine memoizes on
 * its own, server-side, by that id. Wrapping it in an outer `engineStep.run`
 * would nest one step call inside another's callback — invalid on the real
 * engine — and would only double a memoization the gate already has. A
 * resume after a worker restart replays the approval decision from the
 * gate's own checkpoint, never re-prompting (R3.5/3.7). Non-flagged steps
 * pass straight through.
 *
 * A granted decision's (possibly edited) `args` (R3.4 "edit arguments") is
 * threaded into the checkpointed step call so the specialist that actually
 * runs sees the operator's edit, not the original call — see
 * `createSupervisorWorkflow`'s `mergeApprovedArgs`, which is what `fn` closes
 * over here.
 *
 * Fail-closed: a step that requires approval with no `approvalGate` configured is
 * denied ({@link ApprovalDeniedError} `misconfigured`) rather than run unapproved.
 */
export function createDurableStepRunner(
	engineStep: WorkflowStepRunner,
	options: CreateDurableStepRunnerOptions,
): WorkflowStepRunner {
	const {
		jobId,
		requiresApproval,
		approvalGate,
		approvalTimeout = DEFAULT_APPROVAL_TIMEOUT,
	} = options;

	return {
		async run<T>(stepId: string, fn: (approvedArgs?: unknown) => Promise<T>): Promise<T> {
			if (requiresApproval?.(stepId)) {
				if (!approvalGate) throw new ApprovalDeniedError(stepId, "misconfigured");
				const decision = await approvalGate({ jobId, stepId, timeout: approvalTimeout });
				if (decision === null) throw new ApprovalDeniedError(stepId, "expired");
				if (!decision.approved) throw new ApprovalDeniedError(stepId, "rejected");
				return engineStep.run(stepId, () => fn(decision.args));
			}
			return engineStep.run(stepId, () => fn());
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Deps composition root (ADR-3)                                              */
/* -------------------------------------------------------------------------- */

/** Overrides for {@link buildWorkerDeps} — the container supplies db + audit sink. */
export interface BuildWorkerDepsOptions {
	db?: unknown;
	logger?: Logger;
	audit?: AuditSink;
}

/**
 * Console-backed logger honoring the R4.7 privacy contract: it records only the
 * message and explicitly-passed fields — raw prompts / tool I/O are never
 * forwarded here. Mirrors the sink built in `apps/web`'s chat route.
 */
const consoleLogger: Logger = {
	debug: (message, fields) => (fields ? console.debug(message, fields) : console.debug(message)),
	info: (message, fields) => (fields ? console.info(message, fields) : console.info(message)),
	warn: (message, fields) => (fields ? console.warn(message, fields) : console.warn(message)),
	error: (message, fields) => (fields ? console.error(message, fields) : console.error(message)),
};

/**
 * Build the worker's {@link AgentDeps}. As the composition root, this is the one
 * legitimate place to instantiate the real wall clock (`now: () => new Date()`);
 * downstream tools/agents read `deps.now()` and never call `new Date()` (ADR-3).
 * The DB client and audit sink (Task 13.4) are injected by the container edge.
 */
export function buildWorkerDeps(options: BuildWorkerDepsOptions = {}): AgentDeps {
	return {
		db: options.db ?? null,
		logger: options.logger ?? consoleLogger,
		now: () => new Date(),
		audit: options.audit,
	};
}

/* -------------------------------------------------------------------------- */
/* Job execution                                                              */
/* -------------------------------------------------------------------------- */

/** Options for {@link runJob}: the durable-step port, event sink, tracer,
 * approval gating (R3.4/3.5), and supervisor overrides (specialists / retrieval
 * / model — test + extension seam). */
export interface RunJobOptions extends CreateSupervisorWorkflowOptions {
	/** OTel tracer for job + step spans (default: {@link noopTracer}). */
	tracer?: WorkerTracer;
	/** Predicate marking a step destructive → suspend for approval before it runs (R3.4). */
	requiresApproval?: (stepId: string) => boolean;
	/** Durable approval-await (Inngest `step.waitForEvent`); required for flagged steps. */
	approvalGate?: ApprovalGate;
	/** Approval-wait window (default {@link DEFAULT_APPROVAL_TIMEOUT}). */
	approvalTimeout?: string;
	/**
	 * Persists job ownership (`job.id`/`job.userId`) before dispatch so
	 * `apps/web`'s approve/stream routes can look up who owns a job (R5.1, Task
	 * 21.3). Optional no-op when omitted (Phase 1/2 callers, and tests, are
	 * unaffected). The insert is idempotent ({@link createJobStore} uses
	 * `onConflictDoNothing`), so an Inngest retry/resume replay of this function
	 * body is a safe no-op; a genuine failure (e.g. the DB is down) still
	 * propagates and the plan is never dispatched (fail-loud).
	 */
	jobStore?: JobStore;
}

/**
 * Validate an inbound {@link JobRequest}. `jobId` must be present; `userId` is a
 * string or null; `plan` is validated against the shared Zod contract (so a
 * malformed plan rejects here rather than deep inside dispatch).
 */
function parseJobRequest(request: JobRequest): JobRequest {
	if (typeof request?.jobId !== "string" || request.jobId.length === 0) {
		throw new Error("JobRequest.jobId must be a non-empty string");
	}
	if (request.userId !== null && typeof request.userId !== "string") {
		throw new Error("JobRequest.userId must be a string or null");
	}
	const plan = supervisorPlanSchema.parse(request.plan);
	return { jobId: request.jobId, userId: request.userId, plan };
}

/**
 * Wrap the caller's {@link JobEventSink} so that, as the supervisor emits the
 * progress union, one child span is opened per specialist step carrying the
 * agent name (R4.2). `step-start` (which alone carries the specialist `kind`)
 * opens the span; the matching `completion` / `error` closes it. Every event is
 * forwarded to `userEmit` unchanged — instrumentation is additive.
 */
function instrumentEmit(
	tracer: WorkerTracer,
	jobId: string,
	userId: string,
	userEmit: JobEventSink | undefined,
): JobEventSink {
	const stepSpans = new Map<string, WorkerSpan>();
	return async (event) => {
		switch (event.type) {
			case "step-start": {
				const span = tracer.startSpan("worker.step", {
					jobId,
					userId,
					stepId: event.stepId,
					agent: event.kind,
				});
				stepSpans.set(event.stepId, span);
				break;
			}
			case "completion": {
				if (event.stepId) {
					stepSpans.get(event.stepId)?.end();
					stepSpans.delete(event.stepId);
				}
				break;
			}
			case "error": {
				if (event.stepId) {
					const span = stepSpans.get(event.stepId);
					span?.setError(event.message);
					span?.end();
					stepSpans.delete(event.stepId);
				}
				break;
			}
			default:
				break;
		}
		await userEmit?.(event);
	};
}

/**
 * Execute one durable job (R3.1/3.2/4.2).
 *
 * Opens a job-level span carrying `jobId` + `userId` (R4.2), routes the
 * supervisor plan through the injected durable-step port (`options.step`;
 * default in-process), attaches an agent-named span per step, and streams the
 * {@link JobEvent} union to `options.emit`. On any step failure the job span is
 * marked errored and the error is rethrown — the durable engine owns
 * retry/resume, so `runJob` never swallows it.
 */
export async function runJob(
	deps: AgentDeps,
	request: JobRequest,
	options: RunJobOptions = {},
): Promise<WorkflowStepResult[]> {
	const { jobId, userId, plan } = parseJobRequest(request);
	const {
		tracer = noopTracer,
		emit: userEmit,
		step: engineStep,
		requiresApproval,
		approvalGate,
		approvalTimeout,
		jobStore,
		...supervisorRest
	} = options;
	const userLabel = userId ?? "anonymous";

	// R5.1 (Task 21.3): persist ownership before dispatch so an authz check can
	// look it up later. This runs on every replay of the Inngest function body
	// (retries, and resume after an approval `waitForEvent`), so the insert is
	// idempotent (`onConflictDoNothing`) — a replayed insert is a safe no-op,
	// while a genuine failure still blocks dispatch (fail-loud).
	await jobStore?.insert({ id: jobId, userId, workflow: "supervisor-plan" });

	const jobSpan = tracer.startSpan("worker.job", { jobId, userId: userLabel });
	const emit = instrumentEmit(tracer, jobId, userLabel, userEmit);

	// When any step needs HITL approval, wrap the durable-step port so it
	// suspends for approval before the checkpointed step (R3.4/3.5); otherwise
	// pass the engine step straight through (undefined → supervisor's in-process
	// default). Both preserve checkpoint replay across a restart (R3.7).
	const step = requiresApproval
		? createDurableStepRunner(engineStep ?? DIRECT_STEP_RUNNER, {
				jobId,
				requiresApproval,
				approvalGate,
				approvalTimeout,
			})
		: engineStep;
	const workflow = createSupervisorWorkflow(deps, {
		...supervisorRest,
		emit,
		...(step ? { step } : {}),
	});

	try {
		const results = await workflow.dispatch(plan, { jobId });
		jobSpan.end();
		return results;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		jobSpan.recordException(error);
		jobSpan.setError(message);
		jobSpan.end();
		throw error;
	}
}

/* -------------------------------------------------------------------------- */
/* Engine binding — worker entry + web↔worker split                           */
/* -------------------------------------------------------------------------- */

/**
 * Build the durable job-function handler. The engine invokes it per
 * `job/requested` event, supplying its durable `step`; the handler routes that
 * step into {@link runJob} so completed steps are checkpointed/memoized by the
 * engine (R3.5/3.7) without this module importing it.
 */
export function createJobHandler(
	deps: AgentDeps,
	options: RunJobOptions = {},
): (ctx: JobFunctionContext) => Promise<WorkflowStepResult[]> {
	return ({ event, step, waitForApproval }) =>
		runJob(deps, event.data, {
			...options,
			step,
			// The engine's durable `waitForApproval` (Inngest `step.waitForEvent`)
			// is the approval gate unless a caller override was supplied (R3.5).
			approvalGate: options.approvalGate ?? waitForApproval,
		});
}

/**
 * Register the worker's durable job function on the engine (the worker entry,
 * R3.1/3.2). The container edge (Task 13.5) calls this with a real Inngest
 * client and then connects it (Inngest Connect / `serve`).
 */
export function registerWorker(
	engine: DurableEngine,
	deps: AgentDeps,
	options: RunJobOptions = {},
): unknown {
	return engine.createFunction(
		JOB_FUNCTION_CONFIG,
		{ event: JOB_REQUESTED_EVENT },
		createJobHandler(deps, options),
	);
}

/**
 * Submit a job from `apps/web` (R3.2 web↔worker decoupling): fire a
 * `job/requested` event and return. The engine durably enqueues it and invokes
 * the worker's function — submission never blocks on execution. `POST /api/jobs`
 * (Task 14.1) calls this after validating the request.
 *
 * Idempotent on `request.jobId` (Inngest `EventPayload.id`): a retried or
 * duplicated submission for the same job collapses to one durable run instead
 * of dispatching the plan twice.
 */
export function submitJob(engine: DurableEngine, request: JobRequest): Promise<unknown> | unknown {
	return engine.send({ name: JOB_REQUESTED_EVENT, data: request, id: request.jobId });
}

/**
 * Submit an approval decision from the web approval UI (Task 14.3), resuming a
 * workflow suspended awaiting approval (R3.5). Fires an {@link APPROVAL_EVENT}
 * the engine matches (by `jobId`) to the suspended `waitForApproval`, which then
 * resumes from its checkpoint — reject/edit-args carried on the signal.
 */
export function submitApproval(
	engine: DurableEngine,
	signal: ApprovalSignal,
): Promise<unknown> | unknown {
	return engine.send({ name: APPROVAL_EVENT, data: signal });
}
