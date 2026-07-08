import { jobEventTypeSchema } from "@vaz/schemas/workflows";
import { getTableColumns } from "drizzle-orm";
import {
	auditLog,
	auditLogInsertSchema,
	job,
	jobEvent,
	jobEventInsertSchema,
	jobEventTypeEnum,
	jobInsertSchema,
	jobStatusEnum,
} from "../src/db/schema";

/**
 * Task 13.7 — Job / JobEvent / AuditLog persistence schema (R3.6 / R5.5).
 *
 * These Drizzle tables back the worker's progress-event store (13.3) and audit
 * sink (13.4); the concrete stores land in 13.8. The schema is validated at the
 * table/contract level here (columns, enum, drizzle-zod) — DDL application needs
 * a live Postgres (8.1 FLAG), exercised end-to-end in Task 15.
 */

describe("job table (R3.2 durable job record)", () => {
	test("has the plan's columns: id / userId / status / workflow / createdAt", () => {
		expect(Object.keys(getTableColumns(job)).sort()).toEqual(
			["createdAt", "id", "status", "userId", "workflow"].sort(),
		);
	});

	test("jobStatusEnum includes 'suspended' for HITL approval waits (R3.5)", () => {
		expect(jobStatusEnum.enumValues).toEqual([
			"pending",
			"running",
			"suspended",
			"completed",
			"failed",
		]);
	});

	test("jobInsertSchema requires workflow and accepts a null userId", () => {
		expect(jobInsertSchema.safeParse({ workflow: "supervisor" }).success).toBe(true);
		expect(jobInsertSchema.safeParse({ workflow: "supervisor", userId: null }).success).toBe(true);
		expect(jobInsertSchema.safeParse({}).success).toBe(false); // workflow required
	});
});

describe("job_event table (R3.6 progress event persistence)", () => {
	test("has the plan's columns: id / jobId / type / payload / ts", () => {
		expect(Object.keys(getTableColumns(jobEvent)).sort()).toEqual(
			["id", "jobId", "payload", "ts", "type"].sort(),
		);
	});

	test("job_event_type enum matches the 11.2 JobEvent discriminants exactly (no drift)", () => {
		expect(jobEventTypeEnum.enumValues).toEqual(jobEventTypeSchema.options);
	});

	test("jobEventInsertSchema requires jobId and type", () => {
		const jobId = "11111111-1111-4111-8111-111111111111";
		expect(jobEventInsertSchema.safeParse({ jobId, type: "step-start" }).success).toBe(true);
		expect(jobEventInsertSchema.safeParse({ type: "step-start" }).success).toBe(false);
	});
});

describe("audit_log table (R5.5 record every tool execution)", () => {
	test("has the plan's columns: id / jobId / userId / tool / args / ts", () => {
		expect(Object.keys(getTableColumns(auditLog)).sort()).toEqual(
			["args", "id", "jobId", "tool", "ts", "userId"].sort(),
		);
	});

	test("requires tool and accepts null jobId + null userId (sync chat path, R5.5)", () => {
		expect(
			auditLogInsertSchema.safeParse({
				tool: "sendEmail",
				jobId: null,
				userId: null,
				args: { to: "x" },
			}).success,
		).toBe(true);
		expect(auditLogInsertSchema.safeParse({ jobId: null }).success).toBe(false); // tool required
	});
});
