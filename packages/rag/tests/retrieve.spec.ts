import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import {
	DEFAULT_TOP_K,
	distanceToScore,
	type EmbedQuery,
	type RetrievalMatch,
	type RetrievalStore,
	retrieve,
} from "@vaz/rag/retrieve/index";
import { retrievedChunkSchema } from "@vaz/schemas/rag";

/**
 * Reranker-less vector retrieval (R2.1/2.7). DB- and network-free: the vector
 * store and the query embedder are injected seams. The orchestrator turns
 * cosine distance into the `RetrievedChunk` similarity `score` (9.1 contract),
 * orders most-similar-first, and limits to top-k.
 */

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_A = "22222222-2222-4222-8222-222222222222";
const CHUNK_B = "33333333-3333-4333-8333-333333333333";

const zeroVector = (dim = EMBEDDING_DIM) => new Array<number>(dim).fill(0);
const fakeEmbedQuery =
	(dim = EMBEDDING_DIM): EmbedQuery =>
	async () =>
		zeroVector(dim);

/** A store that records how it was called and returns preset matches. */
class FakeStore implements RetrievalStore {
	matches: RetrievalMatch[] = [];
	lastK: number | null = null;
	lastVector: number[] | null = null;
	async searchByVector(queryVector: number[], k: number) {
		this.lastVector = queryVector;
		this.lastK = k;
		return this.matches;
	}
}

const match = (chunkId: string, ordinal: number, distance: number): RetrievalMatch => ({
	chunkId,
	documentId: DOC_ID,
	source: "docs/a.md",
	ordinal,
	content: `chunk ${ordinal}`,
	distance,
});

describe("distanceToScore", () => {
	test("maps cosine distance to a higher-is-more-similar score", () => {
		expect(distanceToScore(0)).toBe(1);
		expect(distanceToScore(1)).toBeCloseTo(0);
		expect(distanceToScore(0.25)).toBeCloseTo(0.75);
	});
});

describe("retrieve", () => {
	test("returns no results for an empty / whitespace query (no embed, no search)", async () => {
		const store = new FakeStore();
		const embedQuery = vi.fn(fakeEmbedQuery());
		const results = await retrieve("   ", { store, embedQuery });
		expect(results).toEqual([]);
		expect(embedQuery).not.toHaveBeenCalled();
		expect(store.lastK).toBeNull();
	});

	test("maps matches to RetrievedChunks and orders most-similar-first", async () => {
		const store = new FakeStore();
		// intentionally out of order: A is less similar (distance 0.4) than B (0.1)
		store.matches = [match(CHUNK_A, 0, 0.4), match(CHUNK_B, 1, 0.1)];
		const results = await retrieve("how do I onboard?", { store, embedQuery: fakeEmbedQuery() });

		expect(results.map((r) => r.chunkId)).toEqual([CHUNK_B, CHUNK_A]);
		expect(results[0].score).toBeCloseTo(0.9);
		expect(results[1].score).toBeCloseTo(0.6);
		// every result conforms to the 9.1 RetrievedChunk contract
		for (const r of results) expect(retrievedChunkSchema.safeParse(r).success).toBe(true);
	});

	test("defaults to DEFAULT_TOP_K and forwards an override to the store", async () => {
		const store = new FakeStore();
		await retrieve("q", { store, embedQuery: fakeEmbedQuery() });
		expect(store.lastK).toBe(DEFAULT_TOP_K);

		const store2 = new FakeStore();
		await retrieve("q", { store: store2, embedQuery: fakeEmbedQuery(), topK: 3 });
		expect(store2.lastK).toBe(3);
	});

	test("passes the query embedding vector to the store", async () => {
		const store = new FakeStore();
		await retrieve("q", { store, embedQuery: fakeEmbedQuery() });
		expect(store.lastVector).toHaveLength(EMBEDDING_DIM);
	});

	test("throws when the query embedding dimension does not match EMBEDDING_DIM", async () => {
		const store = new FakeStore();
		await expect(retrieve("q", { store, embedQuery: fakeEmbedQuery(512) })).rejects.toThrow();
	});

	test("throws on a non-positive topK", async () => {
		const store = new FakeStore();
		await expect(retrieve("q", { store, embedQuery: fakeEmbedQuery(), topK: 0 })).rejects.toThrow();
	});

	test("throws when the query model differs from the corpus provenance (same dim)", async () => {
		// Corpus embedded with nomic-embed-text; the query is embedded with a
		// different same-dim model → a meaningless cosine space (R2.2/2.3, read side).
		const store: RetrievalStore = {
			async searchByVector() {
				return [];
			},
			async getEmbeddingProfile() {
				return { provider: "ollama", model: "nomic-embed-text", dim: EMBEDDING_DIM };
			},
		};
		await expect(
			retrieve("q", {
				store,
				embedQuery: fakeEmbedQuery(),
				queryProvenance: { provider: "ollama", model: "bge-base" },
			}),
		).rejects.toThrow();
	});

	test("does not guard provenance when the store cannot report it", async () => {
		// getEmbeddingProfile is optional; a store without it (or a null profile)
		// leaves retrieval unguarded rather than throwing.
		const store = new FakeStore();
		store.matches = [match(CHUNK_A, 0, 0.2)];
		const results = await retrieve("q", {
			store,
			embedQuery: fakeEmbedQuery(),
			queryProvenance: { provider: "ollama", model: "bge-base" },
		});
		expect(results).toHaveLength(1);
	});
});
