import { z } from "zod";

/**
 * Typed RAG citation contracts (R2.4).
 *
 * `RetrievedChunk` is what the retrieve path yields per vector-search
 * hit; `Citation` is the lighter, answer-facing reference the chat agent
 * surfaces alongside its reply. Both live in `@vaz/schemas`, the
 * dependency-graph leaf, so `@vaz/rag` (retrieve/tools) and `@vaz/agents`
 * (chat) share one contract without depending on each other.
 *
 * Identity fields are `z.uuid()` to mirror the Drizzle `uuid` primary keys in
 * `@vaz/rag`'s persistence schema (`document.id`, `chunk.id`). The
 * chunk `content` is untrusted corpus text: the chat agent injects it as an
 * explicitly delimited context block, never merged into the system prompt
 * (R5.2) — this module only types it, the delimiting is the agent's job.
 */

/**
 * A single chunk returned by vector search. Carries the chunk's own
 * identity, its parent document's identity + human-readable `source` (both
 * needed to build a {@link Citation} and to score `recall@k` by document ID,
 * R2.5), the chunk `ordinal` within the document, the chunk `content`, and a
 * similarity `score`.
 *
 * `score` convention: higher = more similar. The retrieve path owns its exact
 * range (e.g. cosine similarity), so it is left as a plain number here rather
 * than range-clamped — over-constraining the contract would reject valid
 * scores the retriever legitimately produces.
 *
 * `locator` (Req 4.3) is an optional page→section→char position anchor
 * (`services/agent/app/parse/docling.py#build_locator`, sandbox ADR-4), only
 * populated for chunks ingested via the Docling `--via-parser` path; existing
 * text-file ingest never sets it, keeping this field byte-compatible.
 */
export const retrievedChunkSchema = z.object({
	chunkId: z.uuid(),
	documentId: z.uuid(),
	source: z.string().min(1),
	ordinal: z.number().int().nonnegative(),
	content: z.string(),
	score: z.number(),
	locator: z.string().min(1).optional(),
});

export type RetrievedChunk = z.infer<typeof retrievedChunkSchema>;

/**
 * An answer-facing reference to a cited source (R2.4). Derived from a
 * {@link RetrievedChunk} by {@link toCitation}; this is what the retrieval tool
 * hands back and the chat agent renders. It deliberately excludes
 * the chunk text and score — a citation points at a source, it does not
 * re-carry the passage.
 */
export const citationSchema = z.object({
	documentId: z.uuid(),
	source: z.string().min(1),
	chunkId: z.uuid(),
});

export type Citation = z.infer<typeof citationSchema>;

/**
 * Project a {@link RetrievedChunk} to its {@link Citation}. Single-sources the
 * projection so the retrieval tool and chat agent never
 * re-derive which fields make up a citation.
 */
export function toCitation(chunk: RetrievedChunk): Citation {
	return {
		documentId: chunk.documentId,
		source: chunk.source,
		chunkId: chunk.chunkId,
	};
}
