import { resolveEmbeddingModel } from "@vaz/config/embedding";
// Self-referencing package specifier (see ingest/index.ts): resolves under
// Node's native ESM via the exports map, keeping `@vaz/rag` uniformly runnable.
import { chunk, document, EMBEDDING_DIM, embedding } from "@vaz/rag/db/schema";
import type { Logger } from "@vaz/schemas/deps";
import type { RetrievedChunk } from "@vaz/schemas/rag";
import { embed } from "ai";
import { cosineDistance, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * RAG retrieve path (R2.1): reranker-less vector search (R2.7).
 *
 * Like the ingest path (Task 9.2), the search is expressed over injected seams —
 * a {@link RetrievalStore} and an {@link EmbedQuery} — so {@link retrieve} runs
 * without a database or network in unit tests. The composition roots wire the
 * concrete pgvector store ({@link createDrizzleRetrievalStore}) and the Ollama
 * query embedder ({@link createDefaultQueryEmbedder}) from `@vaz/config`.
 *
 * The store does the nearest-neighbour scan in SQL (pgvector `<=>`, index-backed);
 * the orchestrator converts cosine distance to the `RetrievedChunk` similarity
 * `score` (9.1 contract, higher = more similar) and guarantees most-similar-first
 * ordering regardless of the store's own order.
 */

/** Default number of chunks returned by {@link retrieve}. */
export const DEFAULT_TOP_K = 5;

/** A candidate row from the vector store: cosine `distance` (lower = more similar). */
export interface RetrievalMatch {
	chunkId: string;
	documentId: string;
	source: string;
	ordinal: number;
	content: string;
	distance: number;
}

/** Vector-search port. Implemented by {@link createDrizzleRetrievalStore}. */
export interface RetrievalStore {
	/** Return up to `k` nearest chunks to `queryVector` (the DB does the ORDER BY / LIMIT). */
	searchByVector(queryVector: number[], k: number): Promise<RetrievalMatch[]>;
}

/** Embeds a query string into a vector. Default: {@link createDefaultQueryEmbedder}. */
export type EmbedQuery = (query: string) => Promise<number[]>;

/** Injected dependencies for {@link retrieve}. */
export interface RetrieveDeps {
	store: RetrievalStore;
	embedQuery: EmbedQuery;
	/** Defaults to {@link DEFAULT_TOP_K}. */
	topK?: number;
	logger?: Logger;
}

/**
 * Convert a pgvector cosine distance (`[0, 2]`, lower = more similar) to the
 * `RetrievedChunk` similarity score (higher = more similar) — `1 - distance`.
 */
export function distanceToScore(distance: number): number {
	return 1 - distance;
}

/**
 * Retrieve the top-k chunks most similar to `query` (R2.1/2.7, no reranker).
 * An empty/whitespace query returns `[]` without embedding or searching.
 */
export async function retrieve(query: string, deps: RetrieveDeps): Promise<RetrievedChunk[]> {
	const k = deps.topK ?? DEFAULT_TOP_K;
	if (!Number.isInteger(k) || k <= 0) {
		throw new Error(`topK must be a positive integer, got ${k}`);
	}

	const trimmed = query.trim();
	if (trimmed.length === 0) return [];

	const queryVector = await deps.embedQuery(trimmed);
	if (queryVector.length !== EMBEDDING_DIM) {
		throw new Error(
			`query embedding dimension ${queryVector.length} does not match the DDL-fixed ` +
				`${EMBEDDING_DIM}; the query must be embedded with the same model as the corpus`,
		);
	}

	const matches = await deps.store.searchByVector(queryVector, k);
	return matches
		.map((m) => ({
			chunkId: m.chunkId,
			documentId: m.documentId,
			source: m.source,
			ordinal: m.ordinal,
			content: m.content,
			score: distanceToScore(m.distance),
		}))
		.sort((a, b) => b.score - a.score);
}

/** Resolve the default (env-driven) query embedder via `@vaz/config` (R2.3). */
export function createDefaultQueryEmbedder(
	env: Record<string, string | undefined> = process.env,
): EmbedQuery {
	const model = resolveEmbeddingModel(env);
	return async (query) => {
		const { embedding: vector } = await embed({ model, value: query });
		return vector;
	};
}

/**
 * Drizzle-backed {@link RetrievalStore} using pgvector cosine distance (`<=>`).
 * `db` is any PostgreSQL Drizzle client (driver-agnostic). Index-backed nearest
 * neighbour: `ORDER BY vector <=> query LIMIT k`. Runtime-verified via a
 * reachable database (the `recall@k` test, Task 10, and the chat path, 9.6).
 */
export function createDrizzleRetrievalStore(db: PgDatabase<PgQueryResultHKT>): RetrievalStore {
	return {
		async searchByVector(queryVector, k) {
			const distance = cosineDistance(embedding.vector, queryVector).mapWith(Number);
			return db
				.select({
					chunkId: chunk.id,
					documentId: chunk.documentId,
					source: document.source,
					ordinal: chunk.ordinal,
					content: chunk.content,
					distance,
				})
				.from(embedding)
				.innerJoin(chunk, eq(embedding.chunkId, chunk.id))
				.innerJoin(document, eq(chunk.documentId, document.id))
				.orderBy(distance)
				.limit(k);
		},
	};
}
