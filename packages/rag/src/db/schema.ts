import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * RAG persistence schema (Drizzle ORM, PostgreSQL + pgvector) — R2.2/2.3.
 *
 * Dependency-free `drizzle-orm/pg-core` table builders; no `pg` driver here
 * (the connection lives in the ingest/retrieve paths). Migrations own the
 * `CREATE EXTENSION vector` DDL (docker-compose provisions the server, 8.1).
 *
 * Entities: Document (ingest unit) → Chunk (split) → Embedding (1:1 vector).
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
export const chunk = pgTable("chunk", {
	id: uuid("id").primaryKey().defaultRandom(),
	documentId: uuid("document_id")
		.notNull()
		.references(() => document.id, { onDelete: "cascade" }),
	ordinal: integer("ordinal").notNull(),
	content: text("content").notNull(),
});

/**
 * The embedding vector for a chunk (1:1). `provider`/`dim` record which
 * embedding model produced the vector so the ingest guard (9.2) can reject a
 * corpus that mixes providers or dimensions (R2.2/2.3). The CHECK pins `dim`
 * to the DDL-fixed {@link EMBEDDING_DIM}, so a mismatched write fails at the
 * database boundary rather than silently corrupting similarity search.
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
	},
	(table) => [check("embedding_dim_fixed", sql`${table.dim} = ${sql.raw(String(EMBEDDING_DIM))}`)],
);

// drizzle-zod contracts (R2.2 `drizzle-zod`) — single-sourced from the tables.
export const documentInsertSchema = createInsertSchema(document);
export const documentSelectSchema = createSelectSchema(document);
export const chunkInsertSchema = createInsertSchema(chunk);
export const chunkSelectSchema = createSelectSchema(chunk);
export const embeddingInsertSchema = createInsertSchema(embedding);
export const embeddingSelectSchema = createSelectSchema(embedding);
