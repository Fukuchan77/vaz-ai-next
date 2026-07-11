import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { DEFAULT_EMBEDDING_PROVIDER, resolveEmbeddingModel } from "@vaz/config/embedding";
// Self-referencing package specifier (not `../db/schema`): the exports map
// carries the `.ts` extension, so this resolves under Node's native ESM — the
// ingest CLI (bin/ingest.ts) runs this chain directly via `node`,
// which cannot resolve extensionless relative imports.
import { chunk, document, EMBEDDING_DIM, embedding } from "@vaz/rag/db/schema";
import type { Logger } from "@vaz/schemas/deps";
import { type EmbeddingModel, embedMany } from "ai";
import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * RAG ingest path (R2.1/2.6): loader → chunk → embed → upsert.
 *
 * The pipeline is expressed over injected seams — a persistence {@link IngestStore},
 * an {@link EmbedBatch} embedder, and (optionally) a {@link CorpusLoader} and
 * chunker — so {@link ingest} runs without a network or a database in unit
 * tests. The composition roots (`bin/ingest.ts`; the web wiring)
 * build the concrete Drizzle store + Ollama embedder from `@vaz/config`.
 *
 * The provider/dim guard lives here (not in the DB): the `vector(N)` CHECK pins
 * the dimension, but mixing two providers at the *same* dimension is only
 * detectable at runtime, which {@link assertNoProviderMixing} does (R2.2/2.3).
 */

// ── Chunking ────────────────────────────────────────────────────────────────

export interface ChunkOptions {
	/** Max characters per chunk. */
	size?: number;
	/** Characters shared between consecutive chunks (must be `< size`). */
	overlap?: number;
}

/**
 * Split text into fixed-size character windows with overlap (MVP strategy;
 * no reranker per R2.7). Deterministic and total: every character of the
 * trimmed input lands in at least one window, and consecutive windows share
 * exactly `overlap` characters. Returns `[]` for empty/whitespace-only input.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
	const size = options.size ?? 1000;
	const overlap = options.overlap ?? 200;
	if (!Number.isInteger(size) || size <= 0) {
		throw new Error(`chunk size must be a positive integer, got ${size}`);
	}
	if (!Number.isInteger(overlap) || overlap < 0) {
		throw new Error(`chunk overlap must be a non-negative integer, got ${overlap}`);
	}
	if (overlap >= size) {
		throw new Error(`chunk overlap (${overlap}) must be smaller than size (${size})`);
	}

	const clean = text.trim();
	if (clean.length === 0) return [];
	if (clean.length <= size) return [clean];

	const step = size - overlap;
	const chunks: string[] = [];
	for (let start = 0; start < clean.length; start += step) {
		chunks.push(clean.slice(start, start + size));
		if (start + size >= clean.length) break;
	}
	return chunks;
}

// ── Guards (R2.2/2.3) ─────────────────────────────────────────────────────────

/** The embedding provenance recorded alongside every vector. */
export interface EmbeddingProfile {
	provider: string;
	model: string;
	dim: number;
}

/**
 * Assert an embedding batch matches its chunks and the DDL-fixed dimension.
 * A dimension other than {@link EMBEDDING_DIM} (or a stray-length vector) would
 * be rejected by the `embedding_dim_fixed` CHECK; failing here first yields a
 * clear "migration + full re-ingest required" error instead of a raw DB error.
 */
export function assertEmbeddingConsistency(
	embeddings: number[][],
	expectedCount: number,
	profile: EmbeddingProfile,
): void {
	if (embeddings.length !== expectedCount) {
		throw new Error(
			`embedding count ${embeddings.length} does not match chunk count ${expectedCount}`,
		);
	}
	if (profile.dim !== EMBEDDING_DIM) {
		throw new Error(
			`embedding dimension ${profile.dim} (provider "${profile.provider}") does not match the ` +
				`DDL-fixed ${EMBEDDING_DIM}; a migration + full re-ingest is required to change it`,
		);
	}
	for (let i = 0; i < embeddings.length; i++) {
		if (embeddings[i].length !== EMBEDDING_DIM) {
			throw new Error(
				`embedding vector ${i} has length ${embeddings[i].length}, expected ${EMBEDDING_DIM}`,
			);
		}
	}
}

/**
 * Refuse to write embeddings that would mix providers/models/dimensions within
 * one corpus (R2.2/2.3). A same-dimension provider *or model* swap corrupts
 * similarity search yet passes the DDL CHECK (which only pins the dimension),
 * so it must be caught at ingest time — the model, not just the provider label,
 * identifies the embedding space.
 */
export function assertNoProviderMixing(
	existing: EmbeddingProfile | null,
	incoming: EmbeddingProfile,
): void {
	if (existing === null) return;
	if (
		existing.provider !== incoming.provider ||
		existing.model !== incoming.model ||
		existing.dim !== incoming.dim
	) {
		throw new Error(
			`corpus already embedded with ${existing.provider}/${existing.model}/${existing.dim}; ` +
				`refusing to mix with ${incoming.provider}/${incoming.model}/${incoming.dim}. ` +
				"Migrate + re-ingest to switch embedding models.",
		);
	}
}

// ── Ports ─────────────────────────────────────────────────────────────────────

/** A raw source document produced by a {@link CorpusLoader}. */
export interface LoadedDocument {
	source: string;
	content: string;
	metadata?: Record<string, unknown> | null;
}

/** Loads a corpus (a path) into raw documents. Default: {@link defaultFileCorpusLoader}. */
export type CorpusLoader = (corpusPath: string) => Promise<LoadedDocument[]>;

/** Embeds a batch of chunk texts and reports the provenance of the vectors. */
export type EmbedBatch = (
	values: string[],
) => Promise<{ embeddings: number[][]; provider: string; model: string; dim: number }>;

/** A document ready to persist: its chunks, their vectors, and the run provenance. */
export interface DocumentUpsert {
	source: string;
	metadata: Record<string, unknown> | null;
	provider: string;
	model: string;
	dim: number;
	chunks: Array<{ ordinal: number; content: string; embedding: number[] }>;
}

/** Persistence port for ingest. Implemented by {@link createDrizzleIngestStore}. */
export interface IngestStore {
	/** The corpus's current embedding provenance, or `null` when empty (for the mixing guard). */
	getEmbeddingProfile(): Promise<EmbeddingProfile | null>;
	/** Persist a document with its chunks + embeddings, replacing any prior copy of the same source. */
	upsertDocument(doc: DocumentUpsert): Promise<{ documentId: string; chunkCount: number }>;
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/** Injected dependencies for {@link ingest}. */
export interface IngestDeps {
	store: IngestStore;
	embed: EmbedBatch;
	/** Defaults to {@link defaultFileCorpusLoader}. */
	loadCorpus?: CorpusLoader;
	/** Defaults to {@link chunkText}. */
	chunk?: (text: string) => string[];
	logger?: Logger;
}

/** Counts returned after an ingest run. */
export interface IngestSummary {
	documents: number;
	chunks: number;
}

/**
 * Ingest a corpus end-to-end (R2.6): load → chunk → embed → guard → upsert.
 * Documents that chunk to nothing (empty/whitespace) are skipped.
 */
export async function ingest(corpusPath: string, deps: IngestDeps): Promise<IngestSummary> {
	const load = deps.loadCorpus ?? defaultFileCorpusLoader;
	const split = deps.chunk ?? chunkText;

	const docs = await load(corpusPath);
	const existing = await deps.store.getEmbeddingProfile();

	let documents = 0;
	let chunks = 0;
	for (const doc of docs) {
		const pieces = split(doc.content);
		if (pieces.length === 0) {
			deps.logger?.warn("ingest: document produced no chunks, skipping", { source: doc.source });
			continue;
		}

		const { embeddings, provider, model, dim } = await deps.embed(pieces);
		assertEmbeddingConsistency(embeddings, pieces.length, { provider, model, dim });
		assertNoProviderMixing(existing, { provider, model, dim });

		const result = await deps.store.upsertDocument({
			source: doc.source,
			metadata: doc.metadata ?? null,
			provider,
			model,
			dim,
			chunks: pieces.map((content, ordinal) => ({
				ordinal,
				content,
				embedding: embeddings[ordinal],
			})),
		});
		documents += 1;
		chunks += result.chunkCount;
	}

	return { documents, chunks };
}

// ── Adapters (composition-root wiring; runtime-verified via 9.5 CLI / live DB) ──

/**
 * Build an {@link EmbedBatch} from an AI SDK `EmbeddingModel` (R2.3). The
 * dimension is read from the returned vectors so it always reflects the model
 * that produced them. Construction is lazy — no network until invoked.
 */
export function createEmbedder(model: EmbeddingModel, provider: string): EmbedBatch {
	return async (values) => {
		const { embeddings } = await embedMany({ model, values });
		// `model.modelId` identifies the embedding space so the mixing guard can
		// reject a same-provider/same-dimension model swap (R2.2/2.3).
		return { embeddings, provider, model: model.modelId, dim: embeddings[0]?.length ?? 0 };
	};
}

/** Resolve the default (env-driven) embedder via `@vaz/config` (R2.3). */
export function createDefaultEmbedder(
	env: Record<string, string | undefined> = process.env,
): EmbedBatch {
	const provider = (env.AI_EMBEDDING_PROVIDER ?? "") || DEFAULT_EMBEDDING_PROVIDER;
	return createEmbedder(resolveEmbeddingModel(env), provider);
}

/** Extensions the filesystem loader treats as ingestible text. */
const TEXT_EXTENSIONS = [".md", ".mdx", ".txt"];

/**
 * Recursively load UTF-8 text files ({@link TEXT_EXTENSIONS}) under a directory,
 * using each file's path relative to the root as its `source` (R2.6). Exercised
 * end-to-end by the CLI.
 */
export const defaultFileCorpusLoader: CorpusLoader = async (corpusPath) => {
	const docs: LoadedDocument[] = [];
	// A single file may be passed directly (not only a directory); load it as one
	// document rather than letting readdir throw an opaque ENOTDIR. A non-text file
	// yields nothing (same extension filter as the directory walk).
	const info = await stat(corpusPath);
	if (info.isFile()) {
		if (TEXT_EXTENSIONS.some((ext) => corpusPath.endsWith(ext))) {
			docs.push({ source: basename(corpusPath), content: await readFile(corpusPath, "utf8") });
		}
		return docs;
	}
	const walk = async (dir: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (TEXT_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
				docs.push({ source: relative(corpusPath, full), content: await readFile(full, "utf8") });
			}
		}
	};
	await walk(corpusPath);
	return docs;
};

/** Drizzle-backed {@link IngestStore}. `db` is any PostgreSQL Drizzle client (driver-agnostic). */
export function createDrizzleIngestStore(db: PgDatabase<PgQueryResultHKT>): IngestStore {
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
		async upsertDocument(doc) {
			return db.transaction(async (tx) => {
				// Idempotent re-ingest: drop the prior copy (cascades chunks + embeddings), then insert fresh.
				await tx.delete(document).where(eq(document.source, doc.source));
				const [inserted] = await tx
					.insert(document)
					.values({ source: doc.source, metadata: doc.metadata })
					.returning({ id: document.id });
				const documentId = inserted.id;

				const chunkRows = await tx
					.insert(chunk)
					.values(doc.chunks.map((c) => ({ documentId, ordinal: c.ordinal, content: c.content })))
					.returning({ id: chunk.id, ordinal: chunk.ordinal });
				const chunkIdByOrdinal = new Map(chunkRows.map((r) => [r.ordinal, r.id]));

				await tx.insert(embedding).values(
					doc.chunks.map((c) => {
						const chunkId = chunkIdByOrdinal.get(c.ordinal);
						if (chunkId === undefined) {
							throw new Error(`no chunk row returned for ordinal ${c.ordinal}`);
						}
						return {
							chunkId,
							vector: c.embedding,
							dim: doc.dim,
							provider: doc.provider,
							model: doc.model,
						};
					}),
				);

				return { documentId, chunkCount: doc.chunks.length };
			});
		},
	};
}
