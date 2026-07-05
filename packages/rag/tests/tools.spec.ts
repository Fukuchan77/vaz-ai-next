import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import type { EmbedQuery, RetrievalMatch, RetrievalStore } from "@vaz/rag/retrieve/index";
import { createRetrievalCapability, type RagDatabase } from "@vaz/rag/tools";
import type { AgentDeps, Logger } from "@vaz/schemas/deps";
import { citationSchema, retrievedChunkSchema } from "@vaz/schemas/rag";

/**
 * Retrieval capability (R2.4): a `tool()` the chat agent registers to answer
 * with cited internal documents. DB/network-free — the vector store and query
 * embedder are injected via the construction seam (like `createChatAgent`'s
 * `model` seam). The tool returns typed `RetrievedChunk[]` + `Citation[]`.
 */

const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_A = "22222222-2222-4222-8222-222222222222";
const CHUNK_B = "33333333-3333-4333-8333-333333333333";

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const makeDeps = (): AgentDeps<RagDatabase> => ({
	// `db` is unused here because the store is injected via options.
	db: {} as unknown as RagDatabase,
	logger: silentLogger,
	now: () => new Date(),
});

const fakeEmbedQuery =
	(dim = EMBEDDING_DIM): EmbedQuery =>
	async () =>
		new Array<number>(dim).fill(0);

class FakeStore implements RetrievalStore {
	matches: RetrievalMatch[] = [];
	lastK: number | null = null;
	async searchByVector(_queryVector: number[], k: number) {
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

describe("createRetrievalCapability", () => {
	test("exposes a searchDocuments tool whose input schema requires a query", () => {
		const cap = createRetrievalCapability(makeDeps(), {
			store: new FakeStore(),
			embedQuery: fakeEmbedQuery(),
		});
		expect(cap.searchDocuments).toBeDefined();
		expect(typeof cap.searchDocuments.execute).toBe("function");
		expect(cap.searchDocuments.inputSchema.safeParse({ query: "hi" }).success).toBe(true);
		expect(cap.searchDocuments.inputSchema.safeParse({}).success).toBe(false);
	});

	test("returns retrieved chunks with 1:1 citations conforming to the 9.1 contracts", async () => {
		const store = new FakeStore();
		store.matches = [match(CHUNK_A, 0, 0.4), match(CHUNK_B, 1, 0.1)];
		const cap = createRetrievalCapability(makeDeps(), { store, embedQuery: fakeEmbedQuery() });

		const result = await cap.searchDocuments.execute({ query: "onboarding" });

		expect(result.chunks).toHaveLength(2);
		expect(result.citations).toHaveLength(2);
		for (const c of result.chunks) expect(retrievedChunkSchema.safeParse(c).success).toBe(true);
		for (const c of result.citations) expect(citationSchema.safeParse(c).success).toBe(true);
		// most-similar-first (B has smaller distance) and citation is the chunk's projection
		expect(result.chunks[0].chunkId).toBe(CHUNK_B);
		expect(result.citations[0]).toEqual({
			documentId: result.chunks[0].documentId,
			source: result.chunks[0].source,
			chunkId: result.chunks[0].chunkId,
		});
	});

	test("returns empty chunks and citations when nothing matches", async () => {
		const cap = createRetrievalCapability(makeDeps(), {
			store: new FakeStore(),
			embedQuery: fakeEmbedQuery(),
		});
		const result = await cap.searchDocuments.execute({ query: "q" });
		expect(result).toEqual({ chunks: [], citations: [] });
	});

	test("uses a per-call topK, else the construction default", async () => {
		const store = new FakeStore();
		const cap = createRetrievalCapability(makeDeps(), {
			store,
			embedQuery: fakeEmbedQuery(),
			topK: 7,
		});
		await cap.searchDocuments.execute({ query: "q" });
		expect(store.lastK).toBe(7); // construction default

		await cap.searchDocuments.execute({ query: "q", topK: 2 });
		expect(store.lastK).toBe(2); // per-call override wins
	});
});
