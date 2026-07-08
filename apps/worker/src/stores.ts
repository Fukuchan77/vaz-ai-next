import { auditLog, jobEvent } from "@vaz/rag/db/schema";
import type { AuditEntry } from "@vaz/schemas/deps";
import type { JobEvent } from "@vaz/schemas/workflows";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { AuditLogStore } from "./audit";
import type { JobEventStore } from "./events";

/**
 * `apps/worker` Postgres-backed persistence stores (R3.6 / R5.5).
 *
 * Concrete Drizzle implementations of the injected ports defined in `events.ts`
 * ({@link JobEventStore}) and `audit.ts` ({@link AuditLogStore}), writing into
 * the Phase-3 tables (`job_event` / `audit_log`, Task 13.7). Like `@vaz/rag`'s
 * `createDrizzle*Store`, `db` is any PostgreSQL Drizzle client
 * (`PgDatabase<PgQueryResultHKT>`, driver-agnostic) — the concrete `pg` pool +
 * `drizzle(...)` instance is created and injected at the container edge (Task
 * 13.9). The row mappers are pure and exported for direct testing; errors
 * propagate to the sink layer, which owns fail-soft (events) vs fail-loud (audit).
 */

/** Row written to `job_event`: base fields become columns; the rest is jsonb. */
export interface JobEventRow {
	jobId: string;
	type: JobEvent["type"];
	ts: Date;
	payload: Record<string, unknown>;
}

/**
 * Map a {@link JobEvent} to its `job_event` row. `jobId` / `type` are columns and
 * the ISO `ts` becomes a `Date` (timestamptz); every remaining discriminant
 * field (stepId / kind / result / toolName / delta / message …) is carried in
 * the jsonb `payload`, so the full union round-trips.
 */
export function toJobEventRow(event: JobEvent): JobEventRow {
	const { jobId, ts, type, ...payload } = event;
	return { jobId, type, ts: new Date(ts), payload };
}

/** Row written to `audit_log` (mirrors {@link AuditEntry} 1:1). */
export interface AuditLogRow {
	jobId: string | null;
	userId: string | null;
	tool: string;
	args: unknown;
	ts: Date;
}

/** Map an {@link AuditEntry} to its `audit_log` row (args persisted here, R5.5). */
export function toAuditLogRow(entry: AuditEntry): AuditLogRow {
	return {
		jobId: entry.jobId,
		userId: entry.userId,
		tool: entry.tool,
		args: entry.args,
		ts: entry.ts,
	};
}

/** Drizzle-backed {@link JobEventStore}: appends one `job_event` row per event (R3.6). */
export function createJobEventStore(db: PgDatabase<PgQueryResultHKT>): JobEventStore {
	return {
		async append(event) {
			await db.insert(jobEvent).values(toJobEventRow(event));
		},
	};
}

/** Drizzle-backed {@link AuditLogStore}: inserts one `audit_log` row per tool exec (R5.5). */
export function createAuditLogStore(db: PgDatabase<PgQueryResultHKT>): AuditLogStore {
	return {
		async insert(entry) {
			await db.insert(auditLog).values(toAuditLogRow(entry));
		},
	};
}
