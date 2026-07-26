-- Baseline DDL (R2.1/2.2): provisions an empty PostgreSQL database with the
-- schema `packages/db/src/schema.ts` declares as of the pre-locator state.
-- `0001_add_locator.sql` (formerly `0000_add_locator.sql`, renamed so lexical
-- order matches apply order) advances this baseline with the `chunk.locator`
-- delta — it is intentionally NOT included here (a duplicate `locator`
-- column definition would make that file's `ALTER TABLE ADD COLUMN` fail on
-- a fresh apply). `packages/db/tests/schema-ddl.spec.ts` asserts that this
-- file plus every delta, applied in order, matches `schema.ts` exactly.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "job_status" AS ENUM ('pending', 'running', 'suspended', 'completed', 'failed');
CREATE TYPE "job_event_type" AS ENUM ('step-start', 'tool-call', 'token', 'completion', 'error');

CREATE TABLE "document" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"source" text NOT NULL,
	"metadata" jsonb,
	"ingested_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "chunk" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"document_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "chunk_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "document"("id") ON DELETE cascade
);
CREATE INDEX "chunk_document_id_idx" ON "chunk" ("document_id");
CREATE UNIQUE INDEX "chunk_document_ordinal_uq" ON "chunk" ("document_id","ordinal");

CREATE TABLE "embedding" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"vector" vector(768) NOT NULL,
	"dim" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	CONSTRAINT "embedding_chunk_id_chunk_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "chunk"("id") ON DELETE cascade,
	CONSTRAINT "embedding_dim_fixed" CHECK ("embedding"."dim" = 768)
);
CREATE INDEX "embedding_vector_hnsw" ON "embedding" USING hnsw ("vector" vector_cosine_ops);

CREATE TABLE "job" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"user_id" text,
	"status" job_status NOT NULL DEFAULT 'pending',
	"workflow" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "job_event" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"type" job_event_type NOT NULL,
	"payload" jsonb,
	"ts" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "job_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE cascade
);
CREATE INDEX "job_event_job_id_ts_idx" ON "job_event" ("job_id","ts");

CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
	"job_id" uuid,
	"user_id" text,
	"tool" text NOT NULL,
	"args" jsonb,
	"ts" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "audit_log_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE set null
);
CREATE INDEX "audit_log_job_id_idx" ON "audit_log" ("job_id");
