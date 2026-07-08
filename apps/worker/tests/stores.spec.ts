import { auditLog, jobEvent } from "@vaz/rag/db/schema";
import type { AuditEntry } from "@vaz/schemas/deps";
import type { JobEvent } from "@vaz/schemas/workflows";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
	createAuditLogStore,
	createJobEventStore,
	toAuditLogRow,
	toJobEventRow,
} from "../src/stores";

/**
 * Task 13.8 — Postgres-backed JobEventStore + AuditLogStore (R3.6 / R5.5).
 *
 * The Drizzle adapters are thin: pure row mappers (`toJobEventRow` /
 * `toAuditLogRow`) + a single `db.insert(table).values(row)`. A fake db captures
 * the `(table, row)` pair, so these tests need no Postgres (8.1 FLAG; live DDL +
 * inserts are exercised in Task 15). Mirrors `@vaz/rag`'s `createDrizzle*Store`.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const STEP_ID = "22222222-2222-4222-8222-222222222222";
const TS_ISO = "2026-07-08T00:00:00.000Z";

/** A fake Drizzle client capturing every insert's target table + values row. */
function fakeDb(): {
	db: PgDatabase<PgQueryResultHKT>;
	inserts: Array<{ table: unknown; row: unknown }>;
} {
	const inserts: Array<{ table: unknown; row: unknown }> = [];
	const db = {
		insert(table: unknown) {
			return {
				values(row: unknown) {
					inserts.push({ table, row });
					return Promise.resolve();
				},
			};
		},
	} as unknown as PgDatabase<PgQueryResultHKT>;
	return { db, inserts };
}

describe("toJobEventRow — JobEvent → job_event row (R3.6)", () => {
	test("splits base fields into columns and variant fields into jsonb payload", () => {
		const event: JobEvent = {
			jobId: JOB_ID,
			ts: TS_ISO,
			type: "step-start",
			stepId: STEP_ID,
			kind: "rag-research",
		};
		const row = toJobEventRow(event);
		expect(row.jobId).toBe(JOB_ID);
		expect(row.type).toBe("step-start");
		expect(row.ts).toBeInstanceOf(Date); // ISO string → timestamptz Date
		expect(row.ts.toISOString()).toBe(TS_ISO);
		expect(row.payload).toEqual({ stepId: STEP_ID, kind: "rag-research" });
	});

	test("job-level completion (no stepId/result) yields an empty payload", () => {
		const row = toJobEventRow({ jobId: JOB_ID, ts: TS_ISO, type: "completion" });
		expect(row.payload).toEqual({});
	});

	test("preserves a completion's result payload", () => {
		const row = toJobEventRow({
			jobId: JOB_ID,
			ts: TS_ISO,
			type: "completion",
			stepId: STEP_ID,
			result: { kind: "data-processing", result: 42 },
		});
		expect(row.payload).toEqual({
			stepId: STEP_ID,
			result: { kind: "data-processing", result: 42 },
		});
	});
});

describe("createJobEventStore — Drizzle append (R3.6)", () => {
	test("appends the mapped row into the job_event table", async () => {
		const { db, inserts } = fakeDb();
		await createJobEventStore(db).append({
			jobId: JOB_ID,
			ts: TS_ISO,
			type: "step-start",
			stepId: STEP_ID,
			kind: "document-generation",
		});
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.table).toBe(jobEvent);
		expect(inserts[0]?.row).toMatchObject({ jobId: JOB_ID, type: "step-start" });
	});
});

describe("toAuditLogRow / createAuditLogStore — audit persistence (R5.5)", () => {
	const entry: AuditEntry = {
		userId: "user-1",
		jobId: JOB_ID,
		tool: "sendEmail",
		args: { to: "a@b.co" },
		ts: new Date(TS_ISO),
	};

	test("maps who / job / tool / args / ts to a row", () => {
		expect(toAuditLogRow(entry)).toEqual({
			userId: "user-1",
			jobId: JOB_ID,
			tool: "sendEmail",
			args: { to: "a@b.co" },
			ts: new Date(TS_ISO),
		});
	});

	test("carries null jobId + null userId (synchronous chat path)", () => {
		const row = toAuditLogRow({ ...entry, jobId: null, userId: null });
		expect(row.jobId).toBeNull();
		expect(row.userId).toBeNull();
	});

	test("inserts the mapped row into the audit_log table", async () => {
		const { db, inserts } = fakeDb();
		await createAuditLogStore(db).insert(entry);
		expect(inserts).toHaveLength(1);
		expect(inserts[0]?.table).toBe(auditLog);
		expect(inserts[0]?.row).toMatchObject({ tool: "sendEmail", jobId: JOB_ID });
	});
});
