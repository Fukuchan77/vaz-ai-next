import type { AgentDeps } from "@vaz/schemas/deps";
import type { SpecialistInput, SupervisorPlan, WorkflowStepResult } from "@vaz/schemas/workflows";
import {
	createInngestHandler,
	type InngestJobContextLike,
	type InngestStepLike,
	registerJobFunction,
	toApprovalGate,
} from "../src/inngest";
import {
	APPROVAL_EVENT,
	JOB_FUNCTION_CONFIG,
	JOB_REQUESTED_EVENT,
	type JobRequest,
} from "../src/main";

/**
 * Inngest binding adapters (R3.2 / R3.5).
 *
 * The concrete engine (`createInngestEngine`) + Connect boot (`start.ts`) are the
 * un-runnable edge (needs the Inngest server / Docker).
 * What IS unit-testable is the adaptation: Inngest `step.waitForEvent` → the
 * engine-agnostic `ApprovalGate`, and the Inngest handler ctx → `runJob`. These
 * run against a FAKE Inngest step, so no SDK server is needed. `createInngestEngine`
 * dynamic-imports `inngest`, so this file never loads the heavy SDK.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

function testDeps(): AgentDeps {
	const fixed = new Date("2026-07-08T00:00:00.000Z");
	return { db: null, logger: { debug() {}, info() {}, warn() {}, error() {} }, now: () => fixed };
}

function plan(): SupervisorPlan {
	return {
		goal: "g",
		steps: [{ stepId: SID, task: { kind: "data-processing", operation: "a", input: 1 } }],
	};
}
function req(): JobRequest {
	return { jobId: JOB_ID, userId: "user-1", plan: plan() };
}

/** A fake Inngest step: `run` passes through; `waitForEvent` returns a scripted result. */
function fakeStep(waitResult: { data?: unknown } | null = null): {
	step: InngestStepLike;
	runIds: string[];
	waits: Array<{ id: string; opts: Record<string, unknown> }>;
} {
	const runIds: string[] = [];
	const waits: Array<{ id: string; opts: Record<string, unknown> }> = [];
	return {
		runIds,
		waits,
		step: {
			run: (id, fn) => {
				runIds.push(id);
				return fn();
			},
			waitForEvent: (id, opts) => {
				waits.push({ id, opts: opts as unknown as Record<string, unknown> });
				return Promise.resolve(waitResult);
			},
		},
	};
}

const specialists = {
	"data-processing": async (_i: Extract<SpecialistInput, { kind: "data-processing" }>) => ({
		kind: "data-processing" as const,
		result: "ok",
	}),
};

describe("toApprovalGate — Inngest step.waitForEvent → ApprovalGate (R3.5)", () => {
	test("resolves the awaited event's decision, correlated by jobId + stepId", async () => {
		const { step, waits } = fakeStep({ data: { approved: true, args: { edited: 1 } } });
		const decision = await toApprovalGate(step)({ jobId: JOB_ID, stepId: SID, timeout: "7d" });

		expect(decision).toEqual({ approved: true, args: { edited: 1 } });
		expect(waits).toHaveLength(1);
		expect(waits[0]?.opts.event).toBe(APPROVAL_EVENT);
		expect(waits[0]?.opts.timeout).toBe("7d");
		expect(String(waits[0]?.opts.if)).toContain(JOB_ID);
		expect(String(waits[0]?.opts.if)).toContain(SID);
	});

	test("returns null when the wait times out", async () => {
		const { step } = fakeStep(null);
		expect(await toApprovalGate(step)({ jobId: JOB_ID, stepId: SID })).toBeNull();
	});

	test("maps a rejection", async () => {
		const { step } = fakeStep({ data: { approved: false } });
		expect(await toApprovalGate(step)({ jobId: JOB_ID, stepId: SID })).toEqual({
			approved: false,
			args: undefined,
		});
	});
});

describe("createInngestHandler — Inngest ctx → runJob (R3.2)", () => {
	test("dispatches the plan, routing each step through the engine's durable step", async () => {
		const { step, runIds } = fakeStep();
		const ctx: InngestJobContextLike = { event: { data: req() }, step };
		const results = await createInngestHandler(testDeps(), { specialists })(ctx);

		expect(results.map((r) => r.stepId)).toEqual([SID]);
		expect(runIds).toContain(SID);
	});

	test("a flagged step suspends via the ctx step.waitForEvent, then runs on approval", async () => {
		const { step, waits } = fakeStep({ data: { approved: true } });
		const ctx: InngestJobContextLike = { event: { data: req() }, step };
		const results = await createInngestHandler(testDeps(), {
			specialists,
			requiresApproval: () => true,
		})(ctx);

		expect(waits).toHaveLength(1); // approval awaited through the engine
		expect(results).toHaveLength(1);
	});
});

describe("registerJobFunction — Inngest function registration (R3.1/3.2)", () => {
	test("registers under the fixed id/retries/trigger and drives runJob when invoked", async () => {
		let captured:
			| {
					config: { id: string; retries?: number; triggers: Array<{ event: string }> };
					handler: (ctx: InngestJobContextLike) => Promise<WorkflowStepResult[]>;
			  }
			| undefined;
		const engine = {
			createFunction: (
				config: { id: string; retries?: number; triggers: Array<{ event: string }> },
				handler: (ctx: InngestJobContextLike) => Promise<WorkflowStepResult[]>,
			) => {
				captured = { config, handler };
				return { id: config.id };
			},
			// biome-ignore lint/suspicious/noExplicitAny: fake engine for the structural createFunction call
		} as any;

		registerJobFunction(engine, testDeps(), { specialists });

		expect(captured?.config.id).toBe(JOB_FUNCTION_CONFIG.id);
		expect(captured?.config.retries).toBe(JOB_FUNCTION_CONFIG.retries);
		expect(captured?.config.triggers).toEqual([{ event: JOB_REQUESTED_EVENT }]);

		const { step } = fakeStep();
		const results = await captured?.handler({ event: { data: req() }, step });
		expect(results?.[0]?.result).toEqual({ kind: "data-processing", result: "ok" });
	});
});
