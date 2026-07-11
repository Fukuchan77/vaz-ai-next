import type { AgentDeps } from "@vaz/schemas/deps";
import type { WorkflowStepResult } from "@vaz/schemas/workflows";
import type { Inngest, InngestFunction } from "inngest";
import {
	APPROVAL_EVENT,
	type ApprovalGate,
	createJobHandler,
	DEFAULT_APPROVAL_TIMEOUT,
	JOB_FUNCTION_CONFIG,
	JOB_REQUESTED_EVENT,
	type JobRequest,
	type RunJobOptions,
} from "./main";

/**
 * `apps/worker` concrete Inngest binding (ADR-2 / spike §9) — R3.1/3.2/3.5.
 *
 * This is the ONE module that knows the engine is Inngest. It adapts Inngest's
 * primitives to the engine-agnostic ports the rest of the worker composes
 * against (`main.ts`): `step.waitForEvent` → {@link ApprovalGate}, and the
 * Inngest handler ctx → {@link createJobHandler}/`runJob`. The adapters are pure
 * and unit-tested with a fake step; the real `Inngest` client is created via a
 * dynamic import inside {@link createInngestEngine} (so importing this module —
 * e.g. in tests — never loads the heavy SDK + its OTel instrumentation), and the
 * Connect boot lives in `start.ts`.
 *
 * NOTE (v4): `EventSchemas.fromZod` (the v3 typed-events helper named in the Task
 * 13.9 plan) was removed in inngest v4 (Standard Schema). The client is created
 * without compile-time event schemas; runtime validation is unaffected — `runJob`
 * already validates each {@link JobRequest} via `supervisorPlanSchema.parse`.
 */

/** Structural view of the Inngest step tools this module uses (`run` + `waitForEvent`). */
export interface InngestStepLike {
	run<T>(id: string, fn: () => Promise<T>): Promise<T>;
	waitForEvent(
		id: string,
		opts: { event: string; timeout: string | number; if?: string; match?: string },
	): Promise<{ data?: unknown } | null>;
}

/** Structural view of the Inngest handler context this module consumes. */
export interface InngestJobContextLike {
	event: { data: JobRequest };
	step: InngestStepLike;
}

/**
 * Adapt Inngest `step.waitForEvent` to the engine-agnostic {@link ApprovalGate}
 * (R3.5). Suspends until an {@link APPROVAL_EVENT} correlated to this job+step
 * arrives (or the timeout elapses → `null`), then maps its payload to an
 * `ApprovalDecision`. The `if` correlation matches both `jobId` and `stepId` so
 * a job with multiple approval steps resumes the right one; `jobId`/`stepId` are
 * `z.uuid()` (safe to interpolate).
 */
export function toApprovalGate(step: InngestStepLike): ApprovalGate {
	return async ({ jobId, stepId, timeout }) => {
		const event = await step.waitForEvent(`await-approval:${stepId}`, {
			event: APPROVAL_EVENT,
			timeout: timeout ?? DEFAULT_APPROVAL_TIMEOUT,
			if: `async.data.jobId == "${jobId}" && async.data.stepId == "${stepId}"`,
		});
		if (!event) return null; // timed out
		const data = (event.data ?? {}) as { approved?: unknown; args?: unknown };
		return { approved: Boolean(data.approved), args: data.args };
	};
}

/**
 * Build the job handler over an Inngest context: routes the engine's durable
 * `step` and the `step.waitForEvent`-backed {@link ApprovalGate} into `runJob`
 * via {@link createJobHandler}. Testable with a fake ctx; used by both
 * {@link registerJobFunction} and unit tests.
 */
export function createInngestHandler(
	deps: AgentDeps,
	options: RunJobOptions = {},
): (ctx: InngestJobContextLike) => Promise<WorkflowStepResult[]> {
	const handler = createJobHandler(deps, options);
	return (ctx) =>
		handler({
			event: { data: ctx.event.data },
			step: { run: (id, fn) => ctx.step.run(id, fn) },
			waitForApproval: toApprovalGate(ctx.step),
		});
}

/**
 * Register the durable job function on a real Inngest client (v4 2-arg
 * `createFunction`): triggered by {@link JOB_REQUESTED_EVENT}, it runs the
 * supervisor plan through the engine's steps (R3.1/3.2). Edge glue — the real
 * ctx is adapted to {@link InngestJobContextLike} at this single boundary.
 */
export function registerJobFunction(
	engine: Inngest.Any,
	deps: AgentDeps,
	options: RunJobOptions = {},
): InngestFunction.Like {
	const handler = createInngestHandler(deps, options);
	return engine.createFunction(
		{
			id: JOB_FUNCTION_CONFIG.id,
			retries: JOB_FUNCTION_CONFIG.retries,
			triggers: [{ event: JOB_REQUESTED_EVENT }],
		},
		// Inngest's ctx is richer than InngestJobContextLike; narrow it at the edge.
		(ctx: { event: { data: unknown }; step: InngestStepLike }) =>
			handler({ event: { data: ctx.event.data as JobRequest }, step: ctx.step }),
	) as InngestFunction.Like;
}

const cachedEngines = new Map<string, Inngest.Any>();

/**
 * Create the self-hosted Inngest client (the durable engine, spike §9). The SDK
 * is dynamic-imported so this module stays out of the test/adapter load path.
 * `id` identifies the app to the Inngest server; env (`INNGEST_BASE_URL`,
 * `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_DEV`) is read by the SDK.
 *
 * Process-cached per resolved `id` (adversarial-review fix): `apps/web`'s
 * `POST /api/jobs`/`.../approve` routes used to call this fresh on every
 * request — unlike the module-scope-cached Postgres client pattern the same
 * routes' DB helpers use (`apps/web/src/lib/db.ts`). The dynamic `import` still
 * only runs on a cache miss, so a module that merely imports this file (e.g.
 * for other exports, in tests) never loads the SDK.
 */
export async function createInngestEngine(options: { id?: string } = {}): Promise<Inngest.Any> {
	const id = options.id ?? "vaz-worker";
	const cached = cachedEngines.get(id);
	if (cached) return cached;
	const { Inngest: InngestClient } = await import("inngest");
	const engine = new InngestClient({ id });
	cachedEngines.set(id, engine);
	return engine;
}
