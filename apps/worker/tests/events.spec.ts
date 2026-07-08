import type { AgentDeps, LogFields } from "@vaz/schemas/deps";
import type { JobEvent } from "@vaz/schemas/workflows";
import { createJobEventSink, type JobEventPublisher, type JobEventStore } from "../src/events";

/**
 * Task 13.3 — progress-event persistence (R3.6).
 *
 * `createJobEventSink` is the worker-side producer: it validates each
 * {@link JobEvent} against the 11.2 contract, appends it to a durable store
 * (DB) and publishes it to a pub/sub channel (Redis) so the SSE route (Task
 * 14.2) can stream it. Both are INJECTED ports, so these tests need no DB/Redis
 * — the concrete Postgres/Redis clients are wired at the container edge (13.5).
 *
 * Persistence is observability-plane and therefore FAIL-SOFT: a store/publish
 * error is logged and swallowed so a transient infra blip never fails the
 * durable job (whose resume state the engine owns, 13.2/13.6).
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "22222222-2222-4222-8222-222222222222";
const TS = "2026-07-08T00:00:00.000Z";

interface LogCall {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	fields?: LogFields;
}

function makeDeps(): { deps: AgentDeps; logs: LogCall[] } {
	const logs: LogCall[] = [];
	const push = (level: LogCall["level"]) => (message: string, fields?: LogFields) => {
		logs.push({ level, message, fields });
	};
	return {
		logs,
		deps: {
			db: null,
			logger: {
				debug: push("debug"),
				info: push("info"),
				warn: push("warn"),
				error: push("error"),
			},
			now: () => new Date(TS),
		},
	};
}

function stepStart(): JobEvent {
	return { jobId: JOB_ID, ts: TS, type: "step-start", stepId: STEP_ID, kind: "rag-research" };
}
function completion(): JobEvent {
	return {
		jobId: JOB_ID,
		ts: TS,
		type: "completion",
		stepId: STEP_ID,
		result: { kind: "data-processing", result: { secret: "PII-payload" } },
	};
}
function toolCall(): JobEvent {
	return {
		jobId: JOB_ID,
		ts: TS,
		type: "tool-call",
		stepId: STEP_ID,
		toolCallId: "call-1",
		toolName: "sendEmail",
		args: { to: "a@b.co", body: "PII-payload" },
	};
}

function recordingStore(fail = false): { store: JobEventStore; appended: JobEvent[] } {
	const appended: JobEvent[] = [];
	return {
		appended,
		store: {
			append: async (event) => {
				if (fail) throw new Error("db down");
				appended.push(event);
			},
		},
	};
}

function recordingPublisher(fail = false): { publisher: JobEventPublisher; published: JobEvent[] } {
	const published: JobEvent[] = [];
	return {
		published,
		publisher: {
			publish: async (event) => {
				if (fail) throw new Error("redis down");
				published.push(event);
			},
		},
	};
}

describe("createJobEventSink — persist + publish (R3.6)", () => {
	test("appends to the store and publishes to the pub/sub channel", async () => {
		const { deps } = makeDeps();
		const { store, appended } = recordingStore();
		const { publisher, published } = recordingPublisher();
		const sink = createJobEventSink(deps, { store, publisher });

		await sink(stepStart());

		expect(appended).toHaveLength(1);
		expect(appended[0]).toMatchObject({ type: "step-start", jobId: JOB_ID, stepId: STEP_ID });
		expect(published).toHaveLength(1);
		expect(published[0]).toMatchObject({ type: "step-start", jobId: JOB_ID });
	});

	test("persists before publishing (history available to a late subscriber)", async () => {
		const { deps } = makeDeps();
		const order: string[] = [];
		const store: JobEventStore = {
			append: async () => {
				order.push("append");
			},
		};
		const publisher: JobEventPublisher = {
			publish: async () => {
				order.push("publish");
			},
		};
		await createJobEventSink(deps, { store, publisher })(completion());
		expect(order).toEqual(["append", "publish"]);
	});

	test("persists every JobEvent variant of the discriminated union", async () => {
		const { deps } = makeDeps();
		const { store, appended } = recordingStore();
		const sink = createJobEventSink(deps, { store });
		for (const event of [stepStart(), toolCall(), completion()]) {
			await sink(event);
		}
		expect(appended.map((e) => e.type)).toEqual(["step-start", "tool-call", "completion"]);
	});

	test("store-only and publisher-only configurations each work", async () => {
		const { deps } = makeDeps();
		const { store, appended } = recordingStore();
		await createJobEventSink(deps, { store })(stepStart());
		expect(appended).toHaveLength(1);

		const { publisher, published } = recordingPublisher();
		await createJobEventSink(deps, { publisher })(stepStart());
		expect(published).toHaveLength(1);
	});

	test("no store and no publisher is a safe no-op", async () => {
		const { deps } = makeDeps();
		await expect(createJobEventSink(deps)(stepStart())).resolves.toBeUndefined();
	});
});

describe("createJobEventSink — fail-soft (observability must not crash the job)", () => {
	test("a store failure is logged and swallowed, and publish still runs", async () => {
		const { deps, logs } = makeDeps();
		const { store } = recordingStore(true);
		const { publisher, published } = recordingPublisher();
		const sink = createJobEventSink(deps, { store, publisher });

		await expect(sink(completion())).resolves.toBeUndefined();
		expect(published).toHaveLength(1); // publish is independent of the store failure
		expect(logs.some((l) => l.level === "error")).toBe(true);
	});

	test("a publisher failure is logged and swallowed", async () => {
		const { deps, logs } = makeDeps();
		const { store, appended } = recordingStore();
		const { publisher } = recordingPublisher(true);
		const sink = createJobEventSink(deps, { store, publisher });

		await expect(sink(stepStart())).resolves.toBeUndefined();
		expect(appended).toHaveLength(1);
		expect(logs.some((l) => l.level === "error")).toBe(true);
	});

	test("failure logs carry no raw event payload (R4.7 privacy)", async () => {
		const { deps, logs } = makeDeps();
		const { store } = recordingStore(true);
		const { publisher } = recordingPublisher(true);
		await createJobEventSink(deps, { store, publisher })(toolCall());

		const serialized = JSON.stringify(logs);
		expect(serialized).not.toContain("PII-payload");
		expect(serialized).not.toContain("a@b.co");
		// but the correlation ids ARE present so failures are diagnosable
		expect(serialized).toContain(JOB_ID);
	});
});

describe("createJobEventSink — validation at the persistence boundary", () => {
	test("drops a malformed event (fails the 11.2 contract) without persisting", async () => {
		const { deps, logs } = makeDeps();
		const { store, appended } = recordingStore();
		const { publisher, published } = recordingPublisher();
		const sink = createJobEventSink(deps, { store, publisher });

		// missing required discriminant fields → not a valid JobEvent
		await expect(sink({ jobId: JOB_ID, ts: TS } as unknown as JobEvent)).resolves.toBeUndefined();
		expect(appended).toHaveLength(0);
		expect(published).toHaveLength(0);
		expect(logs.some((l) => l.level === "warn")).toBe(true);
	});
});
