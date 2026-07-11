import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_EMBEDDING_MODEL_ID } from "@vaz/config/embedding";
import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import { chunkText, createDefaultEmbedder, type EmbedBatch } from "@vaz/rag/ingest/index";
import {
	createDefaultQueryEmbedder,
	type EmbedQuery,
	type RetrievalMatch,
	type RetrievalStore,
	retrieve,
} from "@vaz/rag/retrieve/index";
import { parseAiEnv } from "@vaz/schemas/env";
import type { RetrievedChunk } from "@vaz/schemas/rag";

/**
 * RAG `recall@k` golden-set evaluation (R2.5).
 *
 * Two layers, so this file is meaningful in every CI run:
 *
 *  1. **recall@k scoring logic** (`recallForQuestion` / `distinctDocIds`) and the
 *     **golden-set fixture contract** are exercised deterministically with no
 *     network — they always run and always assert.
 *  2. The **real-embedding integration** seeds an in-memory vector store with the
 *     fixture corpus (using each document's explicit `id`), embeds every chunk and
 *     question with the *configured* embedding model — embeddings only, no LLM —
 *     runs {@link retrieve}, and scores mean recall@k. It auto-skips
 *     when the embedding model is unreachable (the honest-skip pattern used by the
 *     Ollama E2E), so CI stays green without a pulled model, and demonstrates the
 *     real embedding path the moment one is available.
 *
 * The in-memory store reproduces pgvector's cosine `<=>` math (distance = 1 −
 * cosine similarity, `createDrizzleRetrievalStore`), so what it measures — the
 * quality of the configured embeddings for this corpus — is exactly what the
 * database-backed path measures; only the nearest-neighbour scan moves from SQL
 * to JS, keeping the test DB-free like the rest of the `@vaz/rag` unit suite.
 */

// ── Golden set ────────────────────────────────────────────────────────────────

interface GoldenDoc {
	id: string;
	source: string;
	content: string;
}
interface GoldenQuestion {
	id: string;
	question: string;
	expectedDocumentIds: string[];
}
interface GoldenSet {
	description: string;
	k: number;
	corpus: GoldenDoc[];
	questions: GoldenQuestion[];
}

const golden: GoldenSet = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/golden-set.json", import.meta.url)), "utf8"),
);

/** Minimum acceptable mean recall@k for the configured embeddings over the corpus. */
const MIN_MEAN_RECALL = 0.8;

// ── recall@k scoring (pure, deterministic) ─────────────────────────────────────

/** Distinct `documentId`s from retrieved chunks, most-similar-first order preserved. */
function distinctDocIds(chunks: Pick<RetrievedChunk, "documentId">[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const c of chunks) {
		if (!seen.has(c.documentId)) {
			seen.add(c.documentId);
			out.push(c.documentId);
		}
	}
	return out;
}

/**
 * recall@k for one question: the fraction of its expected documents that appear
 * among the retrieved documents. A question with no expected documents scores 1
 * (nothing to miss).
 */
function recallForQuestion(expectedDocumentIds: string[], retrievedDocIds: string[]): number {
	if (expectedDocumentIds.length === 0) return 1;
	const retrieved = new Set(retrievedDocIds);
	const hits = expectedDocumentIds.filter((id) => retrieved.has(id)).length;
	return hits / expectedDocumentIds.length;
}

// ── In-memory vector store (pgvector cosine `<=>`, DB-free) ─────────────────────

interface SeededChunk extends RetrievalMatch {
	vector: number[];
}

/** Cosine distance in `[0, 2]` (lower = more similar), mirroring pgvector `<=>`. */
function cosineDistance(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 1 : 1 - dot / denom;
}

/** A {@link RetrievalStore} that scans seeded chunks in memory (same math as the DB). */
function createInMemoryStore(chunks: SeededChunk[]): RetrievalStore {
	return {
		async searchByVector(queryVector, k) {
			return chunks
				.map(({ vector, ...match }) => ({
					...match,
					distance: cosineDistance(queryVector, vector),
				}))
				.sort((x, y) => x.distance - y.distance)
				.slice(0, k);
		},
	};
}

/**
 * Seed the store with the golden corpus using each document's **explicit `id`**
 * (the ingest path forces a random id, so we bypass it and write the fixture id
 * directly, per the fixture wiring contract). Chunks and vectors are produced by the
 * configured embedder — the corpus goes through the same chunking + embedding the
 * real ingest path uses.
 */
async function seedStore(corpus: GoldenDoc[], embed: EmbedBatch): Promise<RetrievalStore> {
	const seeded: SeededChunk[] = [];
	for (const doc of corpus) {
		const pieces = chunkText(doc.content);
		const { embeddings, dim } = await embed(pieces);
		if (dim !== EMBEDDING_DIM) {
			throw new Error(
				`corpus embedding dimension ${dim} does not match EMBEDDING_DIM ${EMBEDDING_DIM}`,
			);
		}
		pieces.forEach((content, ordinal) => {
			seeded.push({
				chunkId: crypto.randomUUID(),
				documentId: doc.id,
				source: doc.source,
				ordinal,
				content,
				distance: 0,
				vector: embeddings[ordinal],
			});
		});
	}
	return createInMemoryStore(seeded);
}

// ── Embedding-model reachability (honest auto-skip) ────────────────────────────

/**
 * True only when the configured embedding model is reachable and pulled. Probes
 * the (Ollama, Phase 2's only embedding provider) `/models` list for the resolved
 * embedding model id — the same honest check the chat E2E uses, so the test skips
 * (rather than fails) when the model is simply not available.
 */
async function embeddingModelAvailable(): Promise<boolean> {
	const baseURL = parseAiEnv(process.env).OLLAMA_BASE_URL;
	const modelId = (process.env.AI_EMBEDDING_MODEL ?? "") || DEFAULT_EMBEDDING_MODEL_ID;
	try {
		const res = await fetch(`${baseURL}/models`, { signal: AbortSignal.timeout(2_000) });
		if (!res.ok) return false;
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
		const base = modelId.split(":")[0];
		return ids.some((id) => id === modelId || id.split(":")[0] === base);
	} catch {
		return false;
	}
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("recall@k scoring", () => {
	test("distinctDocIds dedupes chunks sharing a document, preserving order", () => {
		const chunks = [
			{ documentId: "a" },
			{ documentId: "b" },
			{ documentId: "a" },
			{ documentId: "c" },
		];
		expect(distinctDocIds(chunks)).toEqual(["a", "b", "c"]);
	});

	test("scores a full hit, a partial multi-doc hit, and a miss", () => {
		expect(recallForQuestion(["a"], ["a", "b", "c"])).toBe(1);
		expect(recallForQuestion(["a", "b"], ["a", "x"])).toBe(0.5);
		expect(recallForQuestion(["a", "b"], ["a", "b", "z"])).toBe(1);
		expect(recallForQuestion(["a"], ["x", "y"])).toBe(0);
	});

	test("a question with no expected documents cannot be missed", () => {
		expect(recallForQuestion([], [])).toBe(1);
	});
});

describe("golden-set fixture contract", () => {
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	test("has a positive k and 20–50 questions over a non-empty corpus", () => {
		expect(golden.k).toBeGreaterThanOrEqual(1);
		expect(golden.corpus.length).toBeGreaterThan(0);
		expect(golden.questions.length).toBeGreaterThanOrEqual(20);
		expect(golden.questions.length).toBeLessThanOrEqual(50);
	});

	test("document ids are unique valid UUIDs", () => {
		const ids = golden.corpus.map((d) => d.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(UUID);
	});

	test("every expected document id resolves to a corpus document", () => {
		const corpusIds = new Set(golden.corpus.map((d) => d.id));
		const questionIds = golden.questions.map((q) => q.id);
		expect(new Set(questionIds).size).toBe(questionIds.length);
		for (const q of golden.questions) {
			expect(q.expectedDocumentIds.length).toBeGreaterThan(0);
			for (const id of q.expectedDocumentIds) expect(corpusIds.has(id)).toBe(true);
		}
	});
});

describe("recall@k against the golden set (real embeddings)", () => {
	const k = golden.k;
	let available = false;
	let embedBatch: EmbedBatch;
	let embedQuery: EmbedQuery;

	beforeAll(async () => {
		embedBatch = createDefaultEmbedder();
		embedQuery = createDefaultQueryEmbedder();
		available = await embeddingModelAvailable();
	});

	test(`configured embeddings retrieve expected documents at mean recall@${k} >= ${MIN_MEAN_RECALL}`, async (ctx) => {
		ctx.skip(
			!available,
			`configured embedding model "${(process.env.AI_EMBEDDING_MODEL ?? "") || DEFAULT_EMBEDDING_MODEL_ID}" ` +
				"is unreachable/unpulled; recall@k demonstration deferred to a reachable embedding environment",
		);

		const store = await seedStore(golden.corpus, embedBatch);

		let total = 0;
		const misses: string[] = [];
		for (const q of golden.questions) {
			const chunks = await retrieve(q.question, { store, embedQuery, topK: k });
			const recall = recallForQuestion(q.expectedDocumentIds, distinctDocIds(chunks));
			if (recall < 1) misses.push(`${q.id} (recall ${recall.toFixed(2)})`);
			total += recall;
		}
		const meanRecall = total / golden.questions.length;

		await ctx.annotate(
			`mean recall@${k} = ${meanRecall.toFixed(3)} over ${golden.questions.length} questions` +
				(misses.length ? `; below-1.0: ${misses.join(", ")}` : "; all questions perfect"),
		);
		expect(meanRecall).toBeGreaterThanOrEqual(MIN_MEAN_RECALL);
	}, 120_000);
});
