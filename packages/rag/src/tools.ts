// `@vaz/rag/retrieve/index` (self-referencing, not `./retrieve/index`): resolves
// under Node's native ESM via the exports map, keeping `@vaz/rag` uniformly runnable.
import { DEFAULT_EMBEDDING_MODEL_ID, DEFAULT_EMBEDDING_PROVIDER } from "@vaz/config/embedding";
import {
	createDefaultQueryEmbedder,
	createDrizzleRetrievalStore,
	DEFAULT_TOP_K,
	type EmbedQuery,
	type QueryProvenance,
	type RetrievalStore,
	retrieve,
} from "@vaz/rag/retrieve/index";
import type { AgentDeps } from "@vaz/schemas/deps";
import { type Citation, type RetrievedChunk, toCitation } from "@vaz/schemas/rag";
import { tool } from "ai";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";

/**
 * RAG retrieval capability (R2.4).
 *
 * Bundles a `searchDocuments` tool the chat agent registers (Task 9.6) to
 * answer with cited internal documents. The tool returns typed
 * {@link RetrievedChunk}[] (grounding text) plus 1:1 {@link Citation}[]
 * (answer-facing references, projected via `toCitation`). The chunk `content`
 * is untrusted corpus text; treating it as an explicitly delimited context
 * block (R5.2) is Phase 5 hardening and is NOT implemented yet — today the tool
 * result is returned as-is and reaches the model as a tool-role message (never
 * merged into the system prompt, but not otherwise delimited/sanitized).
 *
 * Follows the `@vaz/tools` capability pattern (`createTimeCapability`): runtime
 * concerns arrive via `AgentDeps` (ADR-3). The `store`/`embedQuery` options are
 * a test seam — production builds them from `deps.db` (the Drizzle client) and
 * `@vaz/config` (mirroring `createChatAgent`'s `model` seam); unit tests inject
 * fakes so no database or network is touched.
 */

/** The Drizzle client shape the retrieval store needs (driver-agnostic). */
export type RagDatabase = PgDatabase<PgQueryResultHKT>;

/**
 * The provider/model the env-driven default query embedder uses. Read lazily (at
 * call time, not construction) so building the capability never touches embedding
 * env — mirrors the embedder itself. Feeds the retrieve read-side provenance
 * guard (R2.2/2.3); matches the normalization in `createDefaultEmbedder`.
 */
function resolveQueryProvenance(
	env: Record<string, string | undefined> = process.env,
): QueryProvenance {
	return {
		provider: (env.AI_EMBEDDING_PROVIDER ?? "") || DEFAULT_EMBEDDING_PROVIDER,
		model: (env.AI_EMBEDDING_MODEL ?? "") || DEFAULT_EMBEDDING_MODEL_ID,
	};
}

/** Construction-time overrides for {@link createRetrievalCapability}. */
export interface CreateRetrievalCapabilityOptions {
	/** Test seam: override the vector store (default: {@link createDrizzleRetrievalStore} over `deps.db`). */
	store?: RetrievalStore;
	/** Test seam: override the query embedder (default: {@link createDefaultQueryEmbedder}). */
	embedQuery?: EmbedQuery;
	/** Default top-k when a call omits it (default: {@link DEFAULT_TOP_K}). */
	topK?: number;
}

/**
 * `createRetrievalCapability(deps)` — the RAG search capability (R2.4). Returns
 * a `{ searchDocuments }` tool bundle; the chat agent registers it alongside
 * the time tool (Task 9.6).
 */
export function createRetrievalCapability(
	deps: AgentDeps<RagDatabase>,
	options: CreateRetrievalCapabilityOptions = {},
) {
	const store = options.store ?? createDrizzleRetrievalStore(deps.db);
	// Resolve the default query embedder lazily on first use — not at construction —
	// so building the capability (and thus the chat agent) never touches embedding
	// env. Mirrors resolveModel(), which the chat agent resolves per turn inside
	// stream(); a malformed OLLAMA_BASE_URL / AI_EMBEDDING_* must not throw when the
	// agent is merely built.
	let embedQuery = options.embedQuery;
	// When we build the default embedder from env, we also know the provider/model
	// it uses — pass it as the retrieve read-side provenance guard (R2.2/2.3). With
	// an injected embedQuery (tests) the model is unknown, so the guard is skipped.
	const usingDefaultEmbedder = options.embedQuery === undefined;
	const defaultTopK = options.topK ?? DEFAULT_TOP_K;

	const searchDocuments = tool({
		description:
			"社内ドキュメントを検索し、根拠となるチャンクと引用(Citation)を返す。" +
			"ユーザーが社内情報・文書に基づく回答を求めたときに使い、回答には返り値の引用を明示する。",
		inputSchema: z.object({
			query: z.string().min(1).describe("検索クエリ(自然文)。"),
			topK: z
				.number()
				.int()
				.positive()
				.max(20)
				.optional()
				.describe(`取得する最大チャンク数(既定 ${DEFAULT_TOP_K})。`),
		}),
		execute: async ({
			query,
			topK,
		}): Promise<{ chunks: RetrievedChunk[]; citations: Citation[] }> => {
			embedQuery ??= createDefaultQueryEmbedder();
			const chunks = await retrieve(query, {
				store,
				embedQuery,
				topK: topK ?? defaultTopK,
				queryProvenance: usingDefaultEmbedder ? resolveQueryProvenance() : undefined,
				logger: deps.logger,
			});
			return { chunks, citations: chunks.map(toCitation) };
		},
	});

	return { searchDocuments };
}
