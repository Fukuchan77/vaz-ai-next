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
 * Like the ingest path, the search is expressed over injected seams —
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

/** The embedding provenance a corpus was ingested with (mirrors `embedding` columns). */
export interface StoredEmbeddingProfile {
	provider: string;
	model: string;
	dim: number;
}

/** The provider/model the current query is embedded with, for the read-side guard. */
export interface QueryProvenance {
	provider: string;
	model: string;
}

/** Vector-search port. Implemented by {@link createDrizzleRetrievalStore}. */
export interface RetrievalStore {
	/** Return up to `k` nearest chunks to `queryVector` (the DB does the ORDER BY / LIMIT). */
	searchByVector(queryVector: number[], k: number): Promise<RetrievalMatch[]>;
	/**
	 * The corpus's current embedding provenance, or `null` when empty. Optional so
	 * fakes/legacy stores that cannot report it simply leave retrieval unguarded.
	 */
	getEmbeddingProfile?(): Promise<StoredEmbeddingProfile | null>;
}

/** Embeds a query string into a vector. Default: {@link createDefaultQueryEmbedder}. */
export type EmbedQuery = (query: string) => Promise<number[]>;

/** Injected dependencies for {@link retrieve}. */
export interface RetrieveDeps {
	store: RetrievalStore;
	embedQuery: EmbedQuery;
	/** Defaults to {@link DEFAULT_TOP_K}. */
	topK?: number;
	/**
	 * The provider/model the query is embedded with. When both this and the
	 * store's profile are known and differ, retrieval refuses to run — querying a
	 * corpus with a different (even same-dimension) embedding model yields a
	 * meaningless cosine space (R2.2/2.3, read side).
	 */
	queryProvenance?: QueryProvenance;
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

	// Read-side provenance guard: a same-dimension provider/model swap passes the
	// dimension check above but searches a different embedding space (R2.2/2.3).
	if (deps.queryProvenance && deps.store.getEmbeddingProfile) {
		const profile = await deps.store.getEmbeddingProfile();
		if (
			profile &&
			(profile.provider !== deps.queryProvenance.provider ||
				profile.model !== deps.queryProvenance.model)
		) {
			throw new Error(
				`corpus embedded with ${profile.provider}/${profile.model} but the query is embedded ` +
					`with ${deps.queryProvenance.provider}/${deps.queryProvenance.model}; retrieval ` +
					"requires the same embedding model. Restore the embedding config or migrate + re-ingest.",
			);
		}
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
 * reachable database (the `recall@k` test and the chat path).
 */
export function createDrizzleRetrievalStore(db: PgDatabase<PgQueryResultHKT>): RetrievalStore {
	return {
		async getEmbeddingProfile() {
			const rows = await db
				.select({
					provider: embedding.provider,
					model: embedding.model,
					dim: embedding.dim,
				})
				.from(embedding)
				.limit(1);
			return rows[0] ?? null;
		},
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
