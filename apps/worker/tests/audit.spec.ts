import type { AgentDeps, AuditEntry, LogFields } from "@vaz/schemas/deps";
import { type AuditLogStore, createAuditSink } from "../src/audit";

/**
 * Task 13.4 — worker-path `deps.audit` DB sink (R5.5).
 *
 * `createAuditSink` implements the {@link AuditSink} contract: it records every
 * tool execution (who / which job / with what arguments) to an audit log in the
 * database. The DB is an INJECTED port ({@link AuditLogStore}), so these tests
 * need no database — the concrete Postgres client is wired at the container edge
 * (Task 13.5); the firing point is the `@vaz/agents` lifecycle (Task 20.2).
 *
 * FAIL-LOUD (contrast with the fail-soft events sink, 13.3): a mandated audit
 * record must never be silently dropped, so a store failure is logged and
 * RE-THROWN — the firing point owns the fail-open/closed policy. Arguments are
 * persisted to the DB (R5.5's purpose) but never written to logs (R4.7).
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TS = new Date("2026-07-08T00:00:00.000Z");

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
			now: () => TS,
		},
	};
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
	return {
		userId: "user-1",
		jobId: JOB_ID,
		tool: "sendEmail",
		args: { to: "a@b.co", body: "SENSITIVE-ARG" },
		ts: TS,
		...overrides,
	};
}

function recordingStore(fail = false): { store: AuditLogStore; inserted: AuditEntry[] } {
	const inserted: AuditEntry[] = [];
	return {
		inserted,
		store: {
			insert: async (e) => {
				if (fail) throw new Error("db down");
				inserted.push(e);
			},
		},
	};
}

describe("createAuditSink — record every tool execution (R5.5)", () => {
	test("persists who / which job / tool / arguments / ts to the store", async () => {
		const { deps } = makeDeps();
		const { store, inserted } = recordingStore();
		await createAuditSink(deps, { store }).record(entry());

		expect(inserted).toHaveLength(1);
		expect(inserted[0]).toEqual({
			userId: "user-1",
			jobId: JOB_ID,
			tool: "sendEmail",
			args: { to: "a@b.co", body: "SENSITIVE-ARG" },
			ts: TS,
		});
	});

	test("accepts a null jobId (synchronous chat path has no durable job)", async () => {
		const { deps } = makeDeps();
		const { store, inserted } = recordingStore();
		await createAuditSink(deps, { store }).record(entry({ jobId: null }));
		expect(inserted[0]?.jobId).toBeNull();
	});

	test("accepts a null userId (unauthenticated until Phase 5 auth)", async () => {
		const { deps } = makeDeps();
		const { store, inserted } = recordingStore();
		await createAuditSink(deps, { store }).record(entry({ userId: null }));
		expect(inserted[0]?.userId).toBeNull();
	});

	test("records each execution in order", async () => {
		const { deps } = makeDeps();
		const { store, inserted } = recordingStore();
		const sink = createAuditSink(deps, { store });
		await sink.record(entry({ tool: "a" }));
		await sink.record(entry({ tool: "b" }));
		expect(inserted.map((e) => e.tool)).toEqual(["a", "b"]);
	});
});

describe("createAuditSink — fail-loud (a mandated record must not be dropped)", () => {
	test("re-throws when the store fails, and logs the failure", async () => {
		const { deps, logs } = makeDeps();
		const { store } = recordingStore(true);
		await expect(createAuditSink(deps, { store }).record(entry())).rejects.toThrow("db down");
		expect(logs.some((l) => l.level === "error")).toBe(true);
	});

	test("failure log carries correlation ids but no raw arguments (R4.7)", async () => {
		const { deps, logs } = makeDeps();
		const { store } = recordingStore(true);
		await expect(createAuditSink(deps, { store }).record(entry())).rejects.toThrow();

		const serialized = JSON.stringify(logs);
		// arguments (potential PII/secrets) are NEVER written to logs
		expect(serialized).not.toContain("SENSITIVE-ARG");
		expect(serialized).not.toContain("a@b.co");
		// but who/which-job/tool ARE present so the failure is diagnosable
		expect(serialized).toContain(JOB_ID);
		expect(serialized).toContain("sendEmail");
	});
});
