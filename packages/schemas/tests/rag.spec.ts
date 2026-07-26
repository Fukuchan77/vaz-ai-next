import {
	type Citation,
	citationSchema,
	type RetrievedChunk,
	retrievedChunkSchema,
	toCitation,
} from "@vaz/schemas/rag";

/**
 * Typed RAG citation contracts (R2.4). `RetrievedChunk` is the retrieve path's
 * (9.3) unit of a vector-search hit; `Citation` is the answer-facing reference
 * the chat agent (9.6) surfaces. `toCitation` single-sources the projection so
 * the retrieval tool (9.4) never re-implements it. UUID typing mirrors the
 * Drizzle `uuid` primary keys in `@vaz/rag`'s schema (8.3).
 */

// Two distinct, well-formed v4 UUIDs used across the fixtures.
const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";

const validChunk: RetrievedChunk = {
	chunkId: CHUNK_ID,
	documentId: DOC_ID,
	source: "docs/onboarding.md",
	ordinal: 0,
	content: "New hires complete the security training in week one.",
	score: 0.87,
};

describe("retrievedChunkSchema", () => {
	test("accepts a well-formed retrieved chunk", () => {
		const result = retrievedChunkSchema.safeParse(validChunk);
		expect(result.success).toBe(true);
	});

	test("rejects a non-UUID documentId (typed identity contract)", () => {
		const result = retrievedChunkSchema.safeParse({ ...validChunk, documentId: "doc-1" });
		expect(result.success).toBe(false);
	});

	test("rejects a negative ordinal", () => {
		const result = retrievedChunkSchema.safeParse({ ...validChunk, ordinal: -1 });
		expect(result.success).toBe(false);
	});

	test("rejects a non-integer ordinal", () => {
		const result = retrievedChunkSchema.safeParse({ ...validChunk, ordinal: 1.5 });
		expect(result.success).toBe(false);
	});

	test("rejects an empty source", () => {
		const result = retrievedChunkSchema.safeParse({ ...validChunk, source: "" });
		expect(result.success).toBe(false);
	});

	test("accepts and preserves an optional locator (page->section->char)", () => {
		const result = retrievedChunkSchema.safeParse({
			...validChunk,
			locator: "p1:Introduction:c0-42",
		});
		expect(result.success).toBe(true);
		expect(result.data?.locator).toBe("p1:Introduction:c0-42");
	});

	test("omitted locator stays undefined (byte-compatible with existing ingest)", () => {
		const result = retrievedChunkSchema.safeParse(validChunk);
		expect(result.success).toBe(true);
		expect(result.data?.locator).toBeUndefined();
	});

	test("rejects a non-string locator", () => {
		const result = retrievedChunkSchema.safeParse({ ...validChunk, locator: 42 });
		expect(result.success).toBe(false);
	});
});

describe("citationSchema", () => {
	test("accepts a well-formed citation", () => {
		const citation: Citation = {
			documentId: DOC_ID,
			source: "docs/onboarding.md",
			chunkId: CHUNK_ID,
		};
		expect(citationSchema.safeParse(citation).success).toBe(true);
	});

	test("rejects a citation with an empty source", () => {
		const result = citationSchema.safeParse({ documentId: DOC_ID, source: "", chunkId: CHUNK_ID });
		expect(result.success).toBe(false);
	});

	test("rejects a citation with a non-UUID chunkId", () => {
		const result = citationSchema.safeParse({ documentId: DOC_ID, source: "s", chunkId: "nope" });
		expect(result.success).toBe(false);
	});
});

describe("toCitation", () => {
	test("projects a retrieved chunk to its citation (identity + source only)", () => {
		const citation = toCitation(validChunk);
		expect(citation).toEqual({
			documentId: DOC_ID,
			source: "docs/onboarding.md",
			chunkId: CHUNK_ID,
		});
	});

	test("produces a citation that satisfies citationSchema", () => {
		expect(citationSchema.safeParse(toCitation(validChunk)).success).toBe(true);
	});

	test("does not leak chunk content or score into the citation", () => {
		const citation = toCitation(validChunk) as Record<string, unknown>;
		expect(citation.content).toBeUndefined();
		expect(citation.score).toBeUndefined();
	});
});
