"""Docling-backed `/parse` mechanics: conversion, locator assembly, LlamaParse opt-in
decision (Req 4.1/4.2).

`DocumentConverter.convert(...)` performs the real PDF→structure conversion and
`HybridChunker` the token-aware chunking (research.md item 4); both call out to real
models (layout/OCR, the chunker's HuggingFace tokenizer download) and are therefore
exercised by the E2E/manual lane, not unit tests (Req 2.4 network-zero; tasks.md 7.4
pins the chunk→contract mapping with deterministic fakes instead). This module's pure
parts — `build_locator` and `should_use_llamaparse` — are unit-tested directly against
synthetic `DocChunk`/`ParseOptions` inputs (no Docling model I/O).

`chunk_document` accepts an injectable `chunker` for exactly that reason: tests pass a
structure-only `HierarchicalChunker()` (no tokenizer, no network) to exercise the
locator/mapping logic while production leaves the default `HybridChunker()` in place
(Req 4.1's token-aware chunking).
"""

from __future__ import annotations

from io import BytesIO

from docling.document_converter import DocumentConverter
from docling_core.transforms.chunker.base import BaseChunker
from docling_core.transforms.chunker.doc_chunk import DocChunk
from docling_core.transforms.chunker.hybrid_chunker import HybridChunker
from docling_core.types.doc.document import DoclingDocument
from docling_core.types.io import DocumentStream

from app.config import Settings
from app.schemas import ParsedChunk, ParseOptions


def convert_document(*, filename: str, content: bytes) -> DoclingDocument:
    """Convert an uploaded document's raw bytes into a `DoclingDocument` (Req 4.1).

    Wraps `content` in a `DocumentStream` (Docling's in-memory upload input) instead of
    writing a temp file, since the service is stateless (Req 2.3 — no filesystem
    persistence; the stream is transient, held only for the duration of this call).
    """
    stream = DocumentStream(name=filename, stream=BytesIO(content))
    return DocumentConverter().convert(stream).document


def build_locator(chunk: DocChunk) -> str | None:
    """Assemble the page→section→char locator for `chunk` (Req 4.1/4.3, sandbox ADR-4).

    Format: ``p<page_no>:<heading path>:c<char_start>-<char_end>``. Page and char span
    come from the first provenance entry found across the chunk's `doc_items` (a
    chunk's start position is a sufficient citation anchor; `HybridChunker`'s
    peer-merging can span several doc_items per chunk). Section is `meta.headings`
    joined by " > ", or empty when the chunk has no heading context.

    Returns `None` when no doc_item carries provenance (e.g. non-paginated sources),
    matching the **nullable** `chunk.locator` persistence column (Req 4.3) — the
    ingest CLI (Task 8.2) writes exactly this value through unchanged.
    """
    prov = next((p for item in chunk.meta.doc_items for p in item.prov), None)
    if prov is None:
        return None
    section = " > ".join(chunk.meta.headings) if chunk.meta.headings else ""
    char_start, char_end = prov.charspan
    return f"p{prov.page_no}:{section}:c{char_start}-{char_end}"


def chunk_document(
    dl_doc: DoclingDocument, *, source: str, chunker: BaseChunker | None = None
) -> list[ParsedChunk]:
    """Chunk `dl_doc` and map each chunk to the `/parse` boundary contract (Req 4.1/4.3).

    `chunker` defaults to `HybridChunker()` (Docling's token-aware default, Req 4.1);
    pass a structure-only chunker (e.g. `HierarchicalChunker()`) in tests to avoid its
    HuggingFace tokenizer download (Req 2.4 network-zero).
    """
    active_chunker: BaseChunker = chunker if chunker is not None else HybridChunker()
    result: list[ParsedChunk] = []
    for ordinal, chunk in enumerate(active_chunker.chunk(dl_doc=dl_doc)):
        # Explicit raise, not `assert`: assertions are stripped under `python -O`,
        # which would let a non-`DocChunk` reach `build_locator` and fail there
        # with an opaque `AttributeError` instead of this clear message.
        if not isinstance(chunk, DocChunk):
            raise TypeError(f"expected a DocChunk from the chunker, got {type(chunk).__name__}")
        result.append(
            ParsedChunk(
                source=source,
                locator=build_locator(chunk),
                ordinal=ordinal,
                text=active_chunker.contextualize(chunk=chunk),
            )
        )
    return result


def should_use_llamaparse(options: ParseOptions, settings: Settings) -> bool:
    """Decide whether `/parse` should route to LlamaParse (Req 4.2).

    LlamaParse is opt-in and requires both an explicit request flag and a configured
    API key; missing either resolves `False` — the route (Task 7.3) falls back to
    Docling with no error. Actual LlamaParse invocation is `MAY`-strength per Req 4.2
    ("WHERE a key is present... THE parse path MAY use LlamaParse") and out of scope
    for this phase: no dedicated boundary file exists for it, and `services/agent`
    only carries the low-level `llama-cloud` client dependency for a future task to
    build on.
    """
    return options.use_llamaparse and settings.llamaparse_api_key is not None
