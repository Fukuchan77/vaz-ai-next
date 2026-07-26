import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDDING_DIM } from "@vaz/rag/db/schema";
import {
	createAgentServiceParser,
	type DocumentUpsert,
	type EmbedBatch,
	type IngestStore,
	ingest,
	ingestViaParser,
	type ParsedChunk,
	resolveAgentServiceUrl,
} from "@vaz/rag/ingest/index";

/**
 * `--via-parser` ingest path (Req 4.4/4.6, Task 8.1). Pins, ahead of the
 * implementation (Task 8.2):
 *
 * (a) `ingestViaParser` reuses the existing guarded embed+upsert path —
 *     the same provenance guard (`assertNoProviderMixing`) that the default
 *     `ingest()` path enforces — rather than a parallel write path.
 * (b) a `services/agent` reachability failure (network error, non-2xx) fails
 *     loudly with an actionable error and never partially writes.
 * (c) the default (non-parser) `ingest()` path is byte-compatible: it never
 *     depends on a `parse` client and never sets `locator` on a chunk.
 *
 * Network- and DB-free: `store`/`embed`/`parse` are injected seams (same
 * seam style as `ingest.spec.ts`); `createAgentServiceParser`'s own HTTP
 * behavior is exercised with a stubbed global `fetch` (house convention,
 * `apps/web/tests/useJobStream.spec.ts`).
 */

// A fake embedder returning zero-vectors of the DDL-fixed dimension (mirrors ingest.spec.ts).
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

describe("ingestViaParser orchestration (Req 4.4)", () => {
	test("parses via the agent service, embeds, and upserts through the existing guarded path", async () => {
		const store = new FakeStore();
		const parsed: ParsedChunk[] = [
			{ source: "doc.pdf", locator: "p1#s1#c0", ordinal: 0, text: "first chunk" },
			{ source: "doc.pdf", locator: "p1#s2#c120", ordinal: 1, text: "second chunk" },
		];
		const summary = await ingestViaParser("./corpus", {
			store,
			embed: fakeEmbed(),
			parse: async () => parsed,
			listFiles: async () => ["./corpus/doc.pdf"],
		});

		expect(summary).toEqual({ documents: 1, chunks: 2 });
		expect(store.upserts).toHaveLength(1);
		const upsert = store.upserts[0];
		expect(upsert.source).toBe("doc.pdf");
		expect(upsert.provider).toBe("ollama");
		expect(upsert.model).toBe("nomic-embed-text");
		expect(upsert.dim).toBe(EMBEDDING_DIM);
		expect(upsert.chunks.map((c) => c.ordinal)).toEqual([0, 1]);
		expect(upsert.chunks.map((c) => c.locator)).toEqual(["p1#s1#c0", "p1#s2#c120"]);
		for (const c of upsert.chunks) expect(c.embedding).toHaveLength(EMBEDDING_DIM);
	});

	test("refuses to mix embedding providers, the same provenance guard as the default path", async () => {
		const store = new FakeStore();
		store.profile = { provider: "openai", model: "text-embedding-3-small", dim: EMBEDDING_DIM };
		await expect(
			ingestViaParser("./corpus", {
				store,
				embed: fakeEmbed("ollama"),
				parse: async () => [{ source: "doc.pdf", ordinal: 0, text: "chunk" }],
				listFiles: async () => ["./corpus/doc.pdf"],
			}),
		).rejects.toThrow();
		expect(store.upserts).toHaveLength(0);
	});

	test("skips a file that parses to zero chunks (no upsert)", async () => {
		const store = new FakeStore();
		const summary = await ingestViaParser("./corpus", {
			store,
			embed: fakeEmbed(),
			parse: async () => [],
			listFiles: async () => ["./corpus/empty.pdf"],
		});
		expect(summary).toEqual({ documents: 0, chunks: 0 });
		expect(store.upserts).toHaveLength(0);
	});

	test("propagates the parse client's fail-loud error without partially writing (Req 4.6)", async () => {
		const store = new FakeStore();
		const unreachable = async (): Promise<ParsedChunk[]> => {
			throw new Error(
				"services/agent is unreachable at http://localhost:8000 (start it with " +
					"`uv run uvicorn app.main:app --port 8000` in services/agent)",
			);
		};
		await expect(
			ingestViaParser("./corpus", {
				store,
				embed: fakeEmbed(),
				parse: unreachable,
				listFiles: async () => ["./corpus/doc.pdf"],
			}),
		).rejects.toThrow(/unreachable/);
		expect(store.upserts).toHaveLength(0);
	});
});

describe("ingest default path is unaffected by --via-parser (Req 4.6, byte-compatible)", () => {
	test("never depends on a parse client and never sets a chunk locator", async () => {
		const store = new FakeStore();
		const summary = await ingest("./docs", {
			store,
			embed: fakeEmbed(),
			loadCorpus: async () => [{ source: "a.md", content: "the full document body" }],
			chunk: () => ["p0", "p1"],
		});
		expect(summary).toEqual({ documents: 1, chunks: 2 });
		expect(store.upserts).toHaveLength(1);
		for (const c of store.upserts[0].chunks) expect(c.locator).toBeUndefined();
	});
});

describe("resolveAgentServiceUrl (Req 4.6)", () => {
	test("returns AGENT_SERVICE_URL when set", () => {
		const url = "http://localhost:8000";
		expect(resolveAgentServiceUrl({ AGENT_SERVICE_URL: url })).toBe(url);
	});

	test("throws an actionable error when unset", () => {
		expect(() => resolveAgentServiceUrl({})).toThrow(/AGENT_SERVICE_URL/);
	});

	test("throws on a blank AGENT_SERVICE_URL", () => {
		expect(() => resolveAgentServiceUrl({ AGENT_SERVICE_URL: "   " })).toThrow();
	});
});

describe("createAgentServiceParser (Req 4.1/4.4/4.6)", () => {
	let dir: string;
	let file: string;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vaz-parse-"));
		file = join(dir, "doc.pdf");
		await writeFile(file, "pdf-bytes");
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		await rm(dir, { recursive: true, force: true });
	});

	test("posts the file as multipart to <agentServiceUrl>/parse and returns the parsed chunks", async () => {
		const parsedChunks: ParsedChunk[] = [
			{ source: "doc.pdf", locator: "p1#s1#c0", ordinal: 0, text: "hi" },
		];
		fetchMock.mockResolvedValue(new Response(JSON.stringify(parsedChunks), { status: 200 }));

		const parse = createAgentServiceParser("http://localhost:8000");
		const result = await parse(file);

		expect(result).toEqual(parsedChunks);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("http://localhost:8000/parse");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBeInstanceOf(FormData);
	});

	test("fails loudly with an actionable error when the service is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
		const parse = createAgentServiceParser("http://localhost:8000");
		await expect(parse(file)).rejects.toThrow(/http:\/\/localhost:8000/);
	});

	test("fails loudly when the service responds with a non-2xx status", async () => {
		fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
		const parse = createAgentServiceParser("http://localhost:8000");
		await expect(parse(file)).rejects.toThrow(/500/);
	});
});
