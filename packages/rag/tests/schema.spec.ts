import { jobEventTypeSchema } from "@vaz/schemas/workflows";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	auditLog,
	auditLogInsertSchema,
	chunk,
	chunkInsertSchema,
	chunkSelectSchema,
	document,
	embedding,
	job,
	jobEvent,
	jobEventInsertSchema,
	jobEventTypeEnum,
	jobInsertSchema,
	jobStatusEnum,
} from "../src/db/schema";

/**
 * Job / JobEvent / AuditLog persistence schema (R3.6 / R5.5).
 *
 * These Drizzle tables back the worker's progress-event store and audit
 * sink. The schema is validated at the
 * table/contract level here (columns, enum, drizzle-zod) — DDL application needs
 * a live Postgres.
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

describe("chunk table (Req 4.3 locator, byte-compatible)", () => {
	const documentId = "11111111-1111-4111-8111-111111111111";

	test("gains an optional locator column alongside the existing ones", () => {
		expect(Object.keys(getTableColumns(chunk)).sort()).toEqual(
			["content", "documentId", "id", "locator", "ordinal"].sort(),
		);
	});

	test("chunkInsertSchema omits locator without error (existing text ingest stays byte-compatible)", () => {
		expect(chunkInsertSchema.safeParse({ documentId, ordinal: 0, content: "hello" }).success).toBe(
			true,
		);
	});

	test("chunkSelectSchema accepts a null locator (unset by non-parser ingest) and a populated one", () => {
		const base = {
			id: documentId,
			documentId,
			ordinal: 0,
			content: "hello",
		};
		expect(chunkSelectSchema.safeParse({ ...base, locator: null }).success).toBe(true);
		expect(
			chunkSelectSchema.safeParse({ ...base, locator: "page=3;section=2.1;char=145" }).success,
		).toBe(true);
	});
});

/**
 * DDL drift guard — resolves the tables' lazy extra-config callbacks (FK
 * `references(() => …)`, `(table) => [index/check…]`) via `getTableConfig` and
 * pins the constraints the runtime paths rely on: the retrieval query's HNSW
 * cosine index (9.3), the re-ingest ordinal uniqueness (9.2), the DDL-fixed
 * embedding dimension CHECK, and the delete semantics (cascade vs `set null` —
 * an audit record must survive its job's deletion, R5.5).
 */
describe("DDL drift guard (indexes / FKs / CHECK)", () => {
	test("chunk: FK to document cascades, ordinal is unique per document", () => {
		const config = getTableConfig(chunk);
		expect(config.foreignKeys).toHaveLength(1);
		expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
		expect(getTableConfig(config.foreignKeys[0]?.reference().foreignTable ?? document).name).toBe(
			"document",
		);
		expect(
			config.indexes.map((idx) => ({ name: idx.config.name, unique: idx.config.unique })),
		).toEqual([
			{ name: "chunk_document_id_idx", unique: false },
			{ name: "chunk_document_ordinal_uq", unique: true },
		]);
	});

	test("embedding: HNSW cosine index + dim CHECK + cascading FK to chunk", () => {
		const config = getTableConfig(embedding);
		expect(config.checks.map((check) => check.name)).toEqual(["embedding_dim_fixed"]);
		expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
		expect(getTableConfig(config.foreignKeys[0]?.reference().foreignTable ?? document).name).toBe(
			"chunk",
		);
		const [hnsw] = config.indexes;
		expect(hnsw?.config.name).toBe("embedding_vector_hnsw");
		// The op class must match the retrieval query's `<=>` cosine operator —
		// a mismatched op class silently degrades to a sequential scan.
		expect(hnsw?.config.method).toBe("hnsw");
		const [vectorColumn] = hnsw?.config.columns ?? [];
		expect((vectorColumn as { indexConfig?: { opClass?: string } }).indexConfig?.opClass).toBe(
			"vector_cosine_ops",
		);
	});

	test("job_event: FK cascade + (jobId, ts) replay-order index", () => {
		const config = getTableConfig(jobEvent);
		expect(config.foreignKeys[0]?.onDelete).toBe("cascade");
		expect(getTableConfig(config.foreignKeys[0]?.reference().foreignTable ?? document).name).toBe(
			"job",
		);
		expect(config.indexes.map((idx) => idx.config.name)).toEqual(["job_event_job_id_ts_idx"]);
	});

	test("audit_log: FK is `set null` so the compliance record survives job deletion (R5.5)", () => {
		const config = getTableConfig(auditLog);
		expect(config.foreignKeys[0]?.onDelete).toBe("set null");
		expect(getTableConfig(config.foreignKeys[0]?.reference().foreignTable ?? document).name).toBe(
			"job",
		);
		expect(config.indexes.map((idx) => idx.config.name)).toEqual(["audit_log_job_id_idx"]);
	});
});
