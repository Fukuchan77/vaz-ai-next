import {
	type AuditEntry,
	auditEntrySchema,
	type RunAuditEntry,
	runAuditEntrySchema,
} from "@vaz/schemas/deps";

/**
 * `auditEntrySchema` — the finalized Zod contract for a single tool-execution
 * audit record (R5.5). `AuditEntry` was a plain TS interface since
 * Phase 1 (no-op auditing allowed); this promotes it to a validated
 * Zod schema now that Phase 5 wires a real DB sink (`apps/worker/src/audit.ts`,
 * `apps/web/src/lib/audit.ts`) that must reject a
 * malformed entry before it reaches the database.
 *
 * `runAuditEntrySchema` — the contract for `AuditSink.recordRun` (ADR-D, Req
 * 1.4). It extends `runMetricsSchema` (stopReason + token counts + stepCount)
 * with the same `userId`/`jobId`/`ts` identity fields as `auditEntrySchema` —
 * no raw prompts or tool args, only the safe aggregate (R4.7).
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TS = new Date("2026-07-11T00:00:00.000Z");

const validEntry: AuditEntry = {
	userId: "user-1",
	jobId: JOB_ID,
	tool: "sendEmail",
	args: { to: "a@b.co" },
	ts: TS,
};

describe("auditEntrySchema", () => {
	test("accepts a well-formed audit entry", () => {
		expect(auditEntrySchema.safeParse(validEntry).success).toBe(true);
	});

	test("accepts a null userId (unauthenticated until Phase 5 auth, R5.5)", () => {
		expect(auditEntrySchema.safeParse({ ...validEntry, userId: null }).success).toBe(true);
	});

	test("accepts a null jobId (synchronous chat path has no durable job)", () => {
		expect(auditEntrySchema.safeParse({ ...validEntry, jobId: null }).success).toBe(true);
	});

	test("rejects a non-UUID jobId (typed identity contract, mirrors job.id)", () => {
		const result = auditEntrySchema.safeParse({ ...validEntry, jobId: "not-a-uuid" });
		expect(result.success).toBe(false);
	});

	test("rejects an empty tool name", () => {
		expect(auditEntrySchema.safeParse({ ...validEntry, tool: "" }).success).toBe(false);
	});

	test("accepts arbitrary args (tool-specific shape, validated at the tool boundary)", () => {
		expect(auditEntrySchema.safeParse({ ...validEntry, args: ["x", 1, null] }).success).toBe(true);
	});

	test("rejects a string ts (unlike JobEvent, AuditEntry is in-process only — Date, not ISO wire string)", () => {
		const result = auditEntrySchema.safeParse({ ...validEntry, ts: TS.toISOString() });
		expect(result.success).toBe(false);
	});

	test("rejects a missing tool field", () => {
		const { tool, ...rest } = validEntry;
		expect(auditEntrySchema.safeParse(rest).success).toBe(false);
	});
});

const validRunEntry: RunAuditEntry = {
	userId: "user-1",
	jobId: JOB_ID,
	stopReason: "natural",
	inputTokens: 120,
	outputTokens: 340,
	totalTokens: 460,
	stepCount: 2,
	ts: TS,
};

describe("runAuditEntrySchema", () => {
	test("accepts a well-formed run-audit entry", () => {
		expect(runAuditEntrySchema.safeParse(validRunEntry).success).toBe(true);
	});

	test("accepts a null userId (unauthenticated until Phase 5 auth)", () => {
		expect(runAuditEntrySchema.safeParse({ ...validRunEntry, userId: null }).success).toBe(true);
	});

	test("accepts a null jobId (synchronous chat path has no durable job)", () => {
		expect(runAuditEntrySchema.safeParse({ ...validRunEntry, jobId: null }).success).toBe(true);
	});

	test("rejects a non-UUID jobId (mirrors auditEntrySchema's job.id identity contract)", () => {
		expect(runAuditEntrySchema.safeParse({ ...validRunEntry, jobId: "not-a-uuid" }).success).toBe(
			false,
		);
	});

	test("rejects a stop reason outside the closed vocabulary", () => {
		expect(runAuditEntrySchema.safeParse({ ...validRunEntry, stopReason: "length" }).success).toBe(
			false,
		);
	});

	test("rejects a negative token count", () => {
		expect(runAuditEntrySchema.safeParse({ ...validRunEntry, inputTokens: -1 }).success).toBe(
			false,
		);
	});

	test("rejects a string ts (in-process only, unlike JobEvent's ISO wire string)", () => {
		expect(runAuditEntrySchema.safeParse({ ...validRunEntry, ts: TS.toISOString() }).success).toBe(
			false,
		);
	});

	test("rejects a missing stopReason field", () => {
		const { stopReason, ...rest } = validRunEntry;
		expect(runAuditEntrySchema.safeParse(rest).success).toBe(false);
	});
});
