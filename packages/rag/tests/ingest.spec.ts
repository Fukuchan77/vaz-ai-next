import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import {
	assertEmbeddingConsistency,
	assertNoProviderMixing,
	type CorpusLoader,
	chunkText,
	type DocumentUpsert,
	type EmbedBatch,
	type IngestStore,
	ingest,
} from "@vaz/rag/ingest/index";

/**
 * Ingest path (R2.1/2.6) — chunking, the provider/dim guard (R2.2/2.3, the
 * runtime detection the DDL CHECK cannot do), and the load→chunk→embed→upsert
 * orchestration. Network- and DB-free: the embedder, store, loader, and
 * chunker are injected seams.
 */

// A fake embedder returning zero-vectors of the DDL-fixed dimension.
const fakeEmbed =
	(provider = "ollama", model = "nomic-embed-text", dim = EMBEDDING_DIM): EmbedBatch =>
	async (values) => ({
		embeddings: values.map(() => new Array<number>(dim).fill(0)),
		provider,
		model,
		dim,
	});

// A fake store that records upserts and reports a configurable existing profile.
class FakeStore implements IngestStore {
	profile: { provider: string; model: string; dim: number } | null = null;
	readonly upserts: DocumentUpsert[] = [];
	async getEmbeddingProfile() {
		return this.profile;
	}
	async upsertDocument(doc: DocumentUpsert) {
		this.upserts.push(doc);
		return { documentId: `doc-${this.upserts.length}`, chunkCount: doc.chunks.length };
	}
}

describe("chunkText", () => {
	test("returns no chunks for empty / whitespace-only text", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("   \n  ")).toEqual([]);
	});

	test("returns a single trimmed chunk when text fits in one window", () => {
		expect(chunkText("  hello world  ", { size: 100, overlap: 10 })).toEqual(["hello world"]);
	});

	test("splits long text into overlapping windows that cover all content", () => {
		const text = "abcdefghij".repeat(30); // 300 chars
		const chunks = chunkText(text, { size: 100, overlap: 20 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
		// consecutive windows share `overlap` characters
		expect(chunks[0].slice(-20)).toBe(chunks[1].slice(0, 20));
		// the final window reaches the end of the text
		expect(text.endsWith(chunks[chunks.length - 1])).toBe(true);
	});

	test("rejects an overlap that is not smaller than size", () => {
		expect(() => chunkText("abcdef", { size: 10, overlap: 10 })).toThrow();
	});
});

describe("assertEmbeddingConsistency", () => {
	const ok = [new Array<number>(EMBEDDING_DIM).fill(0), new Array<number>(EMBEDDING_DIM).fill(0)];

	test("passes when count and every vector dimension match the DDL-fixed dim", () => {
		expect(() =>
			assertEmbeddingConsistency(ok, 2, {
				provider: "ollama",
				model: "nomic-embed-text",
				dim: EMBEDDING_DIM,
			}),
		).not.toThrow();
	});

	test("throws when the reported dim differs from EMBEDDING_DIM", () => {
		expect(() =>
			assertEmbeddingConsistency(ok, 2, {
				provider: "openai",
				model: "text-embedding-3-small",
				dim: 1536,
			}),
		).toThrow();
	});

	test("throws when the embedding count does not match the chunk count", () => {
		expect(() =>
			assertEmbeddingConsistency(ok, 3, {
				provider: "ollama",
				model: "nomic-embed-text",
				dim: EMBEDDING_DIM,
			}),
		).toThrow();
	});

	test("throws when an individual vector has the wrong length", () => {
		const bad = [new Array<number>(EMBEDDING_DIM).fill(0), new Array<number>(512).fill(0)];
		expect(() =>
			assertEmbeddingConsistency(bad, 2, {
				provider: "ollama",
				model: "nomic-embed-text",
				dim: EMBEDDING_DIM,
			}),
		).toThrow();
	});
});

describe("assertNoProviderMixing", () => {
	test("passes when the store is empty", () => {
		expect(() =>
			assertNoProviderMixing(null, { provider: "ollama", model: "nomic-embed-text", dim: 768 }),
		).not.toThrow();
	});

	test("passes when incoming matches the existing profile", () => {
		expect(() =>
			assertNoProviderMixing(
				{ provider: "ollama", model: "nomic-embed-text", dim: 768 },
				{ provider: "ollama", model: "nomic-embed-text", dim: 768 },
			),
		).not.toThrow();
	});

	test("throws when the incoming provider differs from the stored one", () => {
		expect(() =>
			assertNoProviderMixing(
				{ provider: "ollama", model: "nomic-embed-text", dim: 768 },
				{ provider: "openai", model: "text-embedding-3-small", dim: 768 },
			),
		).toThrow();
	});

	test("throws when the incoming model differs at the same provider and dim", () => {
		// Same provider + same 768-dim, different model = a different embedding
		// space that the DDL CHECK cannot detect (R2.2/2.3).
		expect(() =>
			assertNoProviderMixing(
				{ provider: "ollama", model: "nomic-embed-text", dim: 768 },
				{ provider: "ollama", model: "bge-base", dim: 768 },
			),
		).toThrow();
	});
});

describe("ingest orchestration", () => {
	const singleDocLoader: CorpusLoader = async () => [
		{ source: "a.md", content: "the full document body", metadata: { title: "A" } },
	];

	test("loads, chunks, embeds and upserts a document with sequential ordinals", async () => {
		const store = new FakeStore();
		const summary = await ingest("./docs", {
			store,
			embed: fakeEmbed(),
			loadCorpus: singleDocLoader,
			chunk: () => ["p0", "p1", "p2"],
		});

		expect(summary).toEqual({ documents: 1, chunks: 3 });
		expect(store.upserts).toHaveLength(1);
		const upsert = store.upserts[0];
		expect(upsert.source).toBe("a.md");
		expect(upsert.provider).toBe("ollama");
		expect(upsert.model).toBe("nomic-embed-text");
		expect(upsert.dim).toBe(EMBEDDING_DIM);
		expect(upsert.chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
		for (const c of upsert.chunks) expect(c.embedding).toHaveLength(EMBEDDING_DIM);
	});

	test("skips a document that produces no chunks (no upsert)", async () => {
		const store = new FakeStore();
		const summary = await ingest("./docs", {
			store,
			embed: fakeEmbed(),
			loadCorpus: async () => [{ source: "empty.md", content: "   " }],
			chunk: () => [],
		});
		expect(summary).toEqual({ documents: 0, chunks: 0 });
		expect(store.upserts).toHaveLength(0);
	});

	test("refuses to ingest when it would mix embedding providers (R2.2/2.3)", async () => {
		const store = new FakeStore();
		store.profile = { provider: "openai", model: "text-embedding-3-small", dim: EMBEDDING_DIM };
		await expect(
			ingest("./docs", {
				store,
				embed: fakeEmbed("ollama"),
				loadCorpus: singleDocLoader,
				chunk: () => ["p0"],
			}),
		).rejects.toThrow();
		expect(store.upserts).toHaveLength(0);
	});
});

describe("defaultFileCorpusLoader (filesystem)", () => {
	test("reads text files from a directory as documents", async () => {
		const { defaultFileCorpusLoader } = await import("@vaz/rag/ingest/index");
		const dir = await mkdtemp(join(tmpdir(), "vaz-ingest-"));
		try {
			await writeFile(join(dir, "one.md"), "first doc");
			await writeFile(join(dir, "two.txt"), "second doc");
			await writeFile(join(dir, "skip.bin"), "ignored");
			const docs = await defaultFileCorpusLoader(dir);
			const sources = docs.map((d) => d.source).sort();
			expect(sources).toEqual(["one.md", "two.txt"]);
			const one = docs.find((d) => d.source === "one.md");
			expect(one?.content).toBe("first doc");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("reads a single text file passed directly as the corpus path", async () => {
		const { defaultFileCorpusLoader } = await import("@vaz/rag/ingest/index");
		const dir = await mkdtemp(join(tmpdir(), "vaz-ingest-file-"));
		try {
			const file = join(dir, "solo.md");
			await writeFile(file, "solo doc body");
			const docs = await defaultFileCorpusLoader(file);
			expect(docs).toHaveLength(1);
			expect(docs[0].source).toBe("solo.md");
			expect(docs[0].content).toBe("solo doc body");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
