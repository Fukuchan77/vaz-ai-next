import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	vector,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * Persistence schema (Drizzle ORM, PostgreSQL + pgvector).
 *
 * Dependency-free `drizzle-orm/pg-core` table builders; no `pg` driver here
 * (the connection lives in the ingest/retrieve paths + the worker stores, 13.8).
 * Migrations own the `CREATE EXTENSION vector` DDL (docker-compose provisions
 * the server, 8.1).
 *
 * Entities:
 *   - RAG (R2.2/2.3): Document (ingest unit) → Chunk (split) → Embedding (1:1 vector).
 *   - Workflow (Phase 3): Job (durable run) → JobEvent (progress union, R3.6);
 *     AuditLog (every tool execution, R5.5). This is the DB home for the
 *     worker's event store (13.3/13.8) and audit sink (13.4/13.8); it lives in
 *     `@vaz/rag` only because that package owns the Drizzle + `pg` setup — a
 *     dedicated `@vaz/db` split is a later refactor, out of Phase 3 scope.
 */

/**
 * DDL-fixed embedding dimension. Ollama `nomic-embed-text` (the default
 * embedding model, resolved by `@vaz/config#resolveEmbeddingModel`) emits
 * 768-dim vectors. `vector(N)` fixes N at DDL time — a provider whose
 * dimension differs (e.g. 1536) requires a migration + full re-ingest, never
 * a runtime column change. The single source of truth for that N.
 */
export const EMBEDDING_DIM = 768;

/** A single ingested source document (R2.1 ingest unit). */
export const document = pgTable("document", {
	id: uuid("id").primaryKey().defaultRandom(),
	source: text("source").notNull(),
	metadata: jsonb("metadata"),
	ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A contiguous slice of a document produced by the chunking strategy (R2.1). */
export const chunk = pgTable(
	"chunk",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		documentId: uuid("document_id")
			.notNull()
			.references(() => document.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		content: text("content").notNull(),
		// Optional page→section→char position anchor (Req 4.3), populated only
		// by the Docling `--via-parser` ingest path (`services/agent/app/parse/
		// docling.py#build_locator`). Nullable so existing text-file ingest never
		// writes a value — byte-compatible with pre-Phase-D rows.
		locator: text("locator"),
	},
	(table) => [
		// Postgres does not auto-index FK columns; this also backs the natural
		// "chunks of a document" lookup and the cascade delete from `document`.
		index("chunk_document_id_idx").on(table.documentId),
		// A re-ingest/retry must not silently duplicate a chunk's position —
		// ordinal is the ordered-reconstruction/provenance key within a document.
		uniqueIndex("chunk_document_ordinal_uq").on(table.documentId, table.ordinal),
	],
);

/**
 * The embedding vector for a chunk (1:1). `provider`/`model`/`dim` record which
 * embedding model produced the vector so the ingest guard (9.2) can reject a
 * corpus that mixes providers, models, or dimensions (R2.2/2.3). The CHECK pins
 * `dim` to the DDL-fixed {@link EMBEDDING_DIM}, so a dimension mismatch fails at
 * the database boundary; a same-dimension provider/model swap passes the CHECK
 * and is caught at ingest time by `assertNoProviderMixing` using `model`.
 */
export const embedding = pgTable(
	"embedding",
	{
		chunkId: uuid("chunk_id")
			.primaryKey()
			.references(() => chunk.id, { onDelete: "cascade" }),
		vector: vector("vector", { dimensions: EMBEDDING_DIM }).notNull(),
		dim: integer("dim").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
	},
	(table) => [
		check("embedding_dim_fixed", sql`${table.dim} = ${sql.raw(String(EMBEDDING_DIM))}`),
		// Without an ANN index, cosine similarity search (`retrieve/index.ts`'s
		// `cosineDistance`, `<=>`) degrades to a full sequential scan with exact
		// distance computation on every query. The op class must match the
		// distance operator the retrieval query actually uses.
		index("embedding_vector_hnsw").using("hnsw", table.vector.op("vector_cosine_ops")),
	],
);

// drizzle-zod contracts (R2.2 `drizzle-zod`) — single-sourced from the tables.
export const documentInsertSchema = createInsertSchema(document);
export const documentSelectSchema = createSelectSchema(document);
export const chunkInsertSchema = createInsertSchema(chunk);
export const chunkSelectSchema = createSelectSchema(chunk);
export const embeddingInsertSchema = createInsertSchema(embedding);
export const embeddingSelectSchema = createSelectSchema(embedding);

/* -------------------------------------------------------------------------- */
/* Workflow persistence (Phase 3) — Job / JobEvent / AuditLog                 */
/* -------------------------------------------------------------------------- */

/**
 * Durable job lifecycle states. `suspended` is the HITL approval-wait state
 * (R3.5) — a job parked on `step.waitForEvent` until an approval event resumes
 * it; `failed` covers both step errors and a rejected/expired approval.
 */
export const jobStatusEnum = pgEnum("job_status", [
	"pending",
	"running",
	"suspended",
	"completed",
	"failed",
]);

/**
 * JobEvent discriminants (R3.6). Kept in lockstep with the engine-agnostic
 * `jobEventTypeSchema` in `@vaz/schemas/workflows` (11.2) — the enum values MUST
 * equal `jobEventTypeSchema.options`, enforced by a drift-guard test so the DB
 * column and the wire contract never diverge. Not imported here to keep this
 * table module free of runtime `@vaz/schemas` coupling.
 */
export const jobEventTypeEnum = pgEnum("job_event_type", [
	"step-start",
	"tool-call",
	"token",
	"completion",
	"error",
]);

/** A durable workflow run (R3.2). `userId` is null when unauthenticated (auth
 * lands in Phase 5); `workflow` names the dispatched workflow kind. */
export const job = pgTable("job", {
	id: uuid("id").primaryKey().defaultRandom(),
	userId: text("user_id"),
	status: jobStatusEnum("status").notNull().default("pending"),
	workflow: text("workflow").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One persisted progress event of a job (R3.6). `type` is the discriminant;
 * `payload` (jsonb) carries the variant-specific fields (stepId / kind / result
 * / toolName / delta / message …) so the full {@link jobEventSchema} union
 * round-trips. Deleting a job cascades its events (ephemeral progress data).
 */
export const jobEvent = pgTable(
	"job_event",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		jobId: uuid("job_id")
			.notNull()
			.references(() => job.id, { onDelete: "cascade" }),
		type: jobEventTypeEnum("type").notNull(),
		payload: jsonb("payload"),
		ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		// Backs the FK's cascade delete and the SSE route's replay-in-order
		// read (a late subscriber's per-job history, oldest first).
		index("job_event_job_id_ts_idx").on(table.jobId, table.ts),
	],
);

/**
 * Audit record for every tool execution (R5.5): who (`userId`), which job
 * (`jobId`, null on the synchronous chat path), the `tool`, and its raw `args`
 * (jsonb — the audit log is the sanctioned place to retain arguments; INFO logs
 * never carry them, R4.7). `jobId` FK is `set null` on delete so a compliance
 * record survives its job's deletion.
 */
export const auditLog = pgTable(
	"audit_log",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),
		userId: text("user_id"),
		tool: text("tool").notNull(),
		args: jsonb("args"),
		ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [index("audit_log_job_id_idx").on(table.jobId)],
);

// drizzle-zod contracts — single-sourced from the tables (mirrors the RAG set).
export const jobInsertSchema = createInsertSchema(job);
export const jobSelectSchema = createSelectSchema(job);
export const jobEventInsertSchema = createInsertSchema(jobEvent);
export const jobEventSelectSchema = createSelectSchema(jobEvent);
export const auditLogInsertSchema = createInsertSchema(auditLog);
export const auditLogSelectSchema = createSelectSchema(auditLog);
