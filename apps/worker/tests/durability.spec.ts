import type { WorkflowStepRunner } from "@vaz/agents/supervisor";
import type { AgentDeps } from "@vaz/schemas/deps";
import type { SpecialistInput, SupervisorPlan } from "@vaz/schemas/workflows";
import {
	APPROVAL_EVENT,
	type ApprovalDecision,
	ApprovalDeniedError,
	type ApprovalGate,
	createDurableStepRunner,
	type DurableEngine,
	type JobRequest,
	runJob,
	submitApproval,
} from "../src/main";

/**
 * Task 13.6 — checkpoint interrupt→resume (R3.5) + restart-crossing completion (R3.7).
 *
 * The durability itself is the engine's (Inngest `step.run` memoization +
 * `step.waitForEvent` suspend). What the worker OWNS — and what these tests
 * exercise with fakes, no engine — is the wiring: an approval-aware,
 * checkpoint-delegating step runner that suspends before a destructive step and
 * resumes from the memoized checkpoint. A memoizing fake models Inngest's
 * server-side step persistence; a second dispatch with the SAME cache models a
 * worker restart. Live proof against a real engine is Task 15's durable E2E.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const SID1 = "22222222-2222-4222-8222-222222222222";
const SID2 = "33333333-3333-4333-8333-333333333333";

function testDeps(): AgentDeps {
	const fixed = new Date("2026-07-08T00:00:00.000Z");
	return {
		db: null,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		now: () => fixed,
	};
}

const DIRECT: WorkflowStepRunner = { run: (_id, fn) => fn() };

/** Models Inngest server-side checkpointing: results memoized by stepId, and a
 * completed step REPLAYS (its `fn` is never re-invoked) on a later run. Sharing
 * one instance across two `runJob` calls simulates a worker restart. */
function memoizingRunner(): {
	runner: WorkflowStepRunner;
	execCount: Map<string, number>;
	cache: Map<string, unknown>;
} {
	const cache = new Map<string, unknown>();
	const execCount = new Map<string, number>();
	return {
		cache,
		execCount,
		runner: {
			async run(stepId, fn) {
				if (cache.has(stepId)) return cache.get(stepId) as never;
				execCount.set(stepId, (execCount.get(stepId) ?? 0) + 1);
				const result = await fn();
				cache.set(stepId, result);
				return result;
			},
		},
	};
}

/**
 * Models the real engine's OWN memoization of `step.waitForEvent` (the
 * primitive `ApprovalGate` is backed by, `apps/worker/src/inngest.ts`'s
 * `toApprovalGate`) — decisions are cached by `stepId` independent of any
 * `step.run` wrapping, since `createDurableStepRunner` no longer routes the
 * approval-await through `engineStep.run` (that nesting is invalid on the
 * real engine; see `main.ts`). Sharing one instance across two `runJob` calls
 * simulates a worker restart that must not re-prompt.
 */
function memoizingGate(decide: () => Promise<ApprovalDecision | null>): {
	gate: ApprovalGate;
	calls: Map<string, number>;
} {
	const cache = new Map<string, ApprovalDecision | null>();
	const calls = new Map<string, number>();
	return {
		calls,
		gate: async ({ stepId }) => {
			if (cache.has(stepId)) return cache.get(stepId) ?? null;
			calls.set(stepId, (calls.get(stepId) ?? 0) + 1);
			const decision = await decide();
			cache.set(stepId, decision);
			return decision;
		},
	};
}

function dp(operation: string): Extract<SpecialistInput, { kind: "data-processing" }> {
	return { kind: "data-processing", operation, input: null };
}
function oneStep(): SupervisorPlan {
	return { goal: "g", steps: [{ stepId: SID1, task: dp("a") }] };
}
function twoStep(): SupervisorPlan {
	return {
		goal: "g",
		steps: [
			{ stepId: SID1, task: dp("a") },
			{ stepId: SID2, task: dp("b") },
		],
	};
}
function req(plan: SupervisorPlan = oneStep()): JobRequest {
	return { jobId: JOB_ID, userId: "user-1", plan };
}

describe("R3.7 — restart-crossing completion via checkpoint replay", () => {
	test("a completed step is not re-executed on restart; the job completes", async () => {
		const { runner, execCount, cache } = memoizingRunner();
		let step2Attempts = 0;
		const specialists = {
			"data-processing": async (input: Extract<SpecialistInput, { kind: "data-processing" }>) => {
				if (input.operation === "b") {
					step2Attempts += 1;
					if (step2Attempts === 1) throw new Error("crash mid-job");
				}
				return { kind: "data-processing" as const, result: input.operation };
			},
		};

		// Run 1: step1 completes + is cached; step2 crashes → the job rejects.
		await expect(runJob(testDeps(), req(twoStep()), { step: runner, specialists })).rejects.toThrow(
			"crash mid-job",
		);
		expect(execCount.get(SID1)).toBe(1);
		expect(cache.has(SID1)).toBe(true);

		// Run 2 (restart, same checkpoint cache): step1 replays (fn NOT re-run),
		// step2 now succeeds → the job completes across the "restart".
		const results = await runJob(testDeps(), req(twoStep()), { step: runner, specialists });
		expect(execCount.get(SID1)).toBe(1); // no double execution of the completed step
		expect(results.map((r) => r.stepId)).toEqual([SID1, SID2]);
	});
});

describe("R3.5 — approval suspend before a destructive step", () => {
	test("approval is awaited before a flagged step; approve lets the step run", async () => {
		const gate: ApprovalGate = vi.fn(async () => ({ approved: true }));
		const specialist = vi.fn(async () => ({ kind: "data-processing" as const, result: "ok" }));
		await runJob(testDeps(), req(), {
			step: DIRECT,
			requiresApproval: (id) => id === SID1,
			approvalGate: gate,
			specialists: { "data-processing": specialist },
		});
		expect(gate).toHaveBeenCalledWith({ jobId: JOB_ID, stepId: SID1, timeout: "7d" });
		expect(specialist).toHaveBeenCalledTimes(1);
	});

	test("a rejected approval throws ApprovalDeniedError and the step never runs", async () => {
		const specialist = vi.fn(async () => ({ kind: "data-processing" as const, result: "x" }));
		await expect(
			runJob(testDeps(), req(), {
				step: DIRECT,
				requiresApproval: () => true,
				approvalGate: async () => ({ approved: false }),
				specialists: { "data-processing": specialist },
			}),
		).rejects.toBeInstanceOf(ApprovalDeniedError);
		expect(specialist).not.toHaveBeenCalled();
	});

	test("an expired approval (timeout → null) throws ApprovalDeniedError(expired)", async () => {
		await expect(
			createDurableStepRunner(DIRECT, {
				jobId: JOB_ID,
				requiresApproval: () => true,
				approvalGate: async () => null,
			}).run(SID1, async () => "never"),
		).rejects.toMatchObject({ stepId: SID1, reason: "expired" });
	});

	test("fail-closed: a step requiring approval with no gate configured is denied", async () => {
		const specialist = vi.fn(async () => ({ kind: "data-processing" as const, result: "x" }));
		await expect(
			runJob(testDeps(), req(), {
				step: DIRECT,
				requiresApproval: () => true,
				specialists: { "data-processing": specialist },
			}),
		).rejects.toBeInstanceOf(ApprovalDeniedError);
		expect(specialist).not.toHaveBeenCalled();
	});

	test("non-flagged steps skip the approval gate entirely", async () => {
		const gate: ApprovalGate = vi.fn(async () => ({ approved: true }));
		await runJob(testDeps(), req(), {
			step: DIRECT,
			requiresApproval: () => false,
			approvalGate: gate,
			specialists: { "data-processing": async () => ({ kind: "data-processing", result: "ok" }) },
		});
		expect(gate).not.toHaveBeenCalled();
	});
});

describe("R3.5 + R3.7 — a granted approval is checkpointed; resume does not re-prompt", () => {
	test("re-dispatch after a crash replays the approval decision (gate not re-invoked)", async () => {
		const { runner } = memoizingRunner();
		const { gate, calls } = memoizingGate(async () => ({ approved: true }));
		let step2Attempts = 0;
		const specialists = {
			"data-processing": async (input: Extract<SpecialistInput, { kind: "data-processing" }>) => {
				if (input.operation === "b") {
					step2Attempts += 1;
					if (step2Attempts === 1) throw new Error("crash after approval");
				}
				return { kind: "data-processing" as const, result: input.operation };
			},
		};
		const opts = {
			step: runner,
			requiresApproval: () => true,
			approvalGate: gate,
			specialists,
		};

		// Run 1: both steps' approvals are granted + memoized by the gate itself
		// (mirroring the real engine's own `step.waitForEvent` memoization); step2
		// then crashes.
		await expect(runJob(testDeps(), req(twoStep()), opts)).rejects.toThrow("crash after approval");
		expect(calls.get(SID1)).toBe(1);
		expect(calls.get(SID2)).toBe(1);

		// Run 2 (restart): approvals replay from the gate's own checkpoint — the
		// gate is NOT re-invoked (no double prompt), and the job completes.
		const results = await runJob(testDeps(), req(twoStep()), opts);
		expect(calls.get(SID1)).toBe(1);
		expect(calls.get(SID2)).toBe(1);
		expect(results.map((r) => r.stepId)).toEqual([SID1, SID2]);
	});
});

describe("R3.4 — an approval's edited arguments are applied to the step that runs", () => {
	test("approving with args merges them into the specialist's task before it runs", async () => {
		const received: unknown[] = [];
		const specialists = {
			"data-processing": async (input: Extract<SpecialistInput, { kind: "data-processing" }>) => {
				received.push(input);
				return { kind: "data-processing" as const, result: input.operation };
			},
		};
		await runJob(testDeps(), req(), {
			step: DIRECT,
			requiresApproval: () => true,
			approvalGate: async () => ({ approved: true, args: { operation: "edited" } }),
			specialists,
		});
		expect(received).toEqual([{ kind: "data-processing", operation: "edited", input: null }]);
	});

	test("editing args cannot change the step's kind (forced back to the plan's kind)", async () => {
		const dataProcessing = vi.fn(async () => ({ kind: "data-processing" as const, result: "x" }));
		const documentGeneration = vi.fn(async () => ({
			kind: "document-generation" as const,
			document: { title: "t", format: "markdown" as const, content: "c" },
		}));
		await runJob(testDeps(), req(), {
			step: DIRECT,
			requiresApproval: () => true,
			// A malicious/mistaken edit tries to swap the specialist entirely.
			approvalGate: async () => ({ approved: true, args: { kind: "document-generation" } }),
			specialists: { "data-processing": dataProcessing, "document-generation": documentGeneration },
		});
		expect(dataProcessing).toHaveBeenCalledTimes(1);
		expect(documentGeneration).not.toHaveBeenCalled();
	});

	test("a malformed edit fails the step instead of running unedited or invalid", async () => {
		const specialist = vi.fn(async () => ({ kind: "data-processing" as const, result: "x" }));
		await expect(
			runJob(testDeps(), req(), {
				step: DIRECT,
				requiresApproval: () => true,
				// `operation` must be a non-empty string per `specialistInputSchema`.
				approvalGate: async () => ({ approved: true, args: { operation: "" } }),
				specialists: { "data-processing": specialist },
			}),
		).rejects.toThrow();
		expect(specialist).not.toHaveBeenCalled();
	});
});

describe("web → engine approval resume signal (R3.5, consumed by Task 14.3)", () => {
	test("submitApproval fires the approval event with the decision signal", async () => {
		const sent: Array<{ name: string; data: unknown }> = [];
		const engine: DurableEngine = {
			createFunction: () => ({}),
			send: async (payload) => {
				sent.push(payload);
			},
		};
		await submitApproval(engine, { jobId: JOB_ID, stepId: SID1, approved: true, args: { x: 1 } });
		expect(sent).toEqual([
			{
				name: APPROVAL_EVENT,
				data: { jobId: JOB_ID, stepId: SID1, approved: true, args: { x: 1 } },
			},
		]);
	});

	test("ApprovalDeniedError carries stepId and reason for the UI to interpret", () => {
		const err = new ApprovalDeniedError(SID1, "rejected");
		expect(err).toBeInstanceOf(Error);
		expect(err.stepId).toBe(SID1);
		expect(err.reason).toBe("rejected");
	});
});
