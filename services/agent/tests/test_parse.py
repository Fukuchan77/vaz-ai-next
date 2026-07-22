"""Unit tests for the `/parse` chunk-to-contract mapping (Req 4.1 / 4.2 / 4.3).

Real Docling conversion (`app.parse.docling.convert_document`, layout/OCR models) and
`HybridChunker`'s tokenizer download are network-bound and deferred to the E2E/manual
lane per this module's docstring; these tests instead pin the pure mapping logic —
`build_locator`, `should_use_llamaparse`, and `chunk_document`'s chunk->`ParsedChunk`
mapping — against synthetic, network-zero `DoclingDocument`/`DocChunk` fixtures.
"""

from __future__ import annotations

import pytest
from docling_core.transforms.chunker.doc_chunk import DocChunk, DocMeta
from docling_core.transforms.chunker.hierarchical_chunker import HierarchicalChunker
from docling_core.types.doc.base import BoundingBox
from docling_core.types.doc.common.reference import ProvenanceItem
from docling_core.types.doc.document import DoclingDocument
from docling_core.types.doc.items.text import TextItem
from docling_core.types.doc.labels import DocItemLabel

from app.config import get_settings
from app.parse.docling import build_locator, chunk_document, should_use_llamaparse
from app.schemas import ParseOptions

_BBOX = BoundingBox(l=0, t=0, r=1, b=1)


def _prov(*, page_no: int, char_start: int, char_end: int) -> ProvenanceItem:
    return ProvenanceItem(page_no=page_no, bbox=_BBOX, charspan=(char_start, char_end))


def _text_item(text: str, *, prov: ProvenanceItem | None = None) -> TextItem:
    doc = DoclingDocument(name="fixture")
    return doc.add_text(label=DocItemLabel.TEXT, text=text, prov=prov)


@pytest.fixture(autouse=True)
def _clean_llamaparse_env(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
    monkeypatch.delenv("LLAMAPARSE_API_KEY", raising=False)


@pytest.fixture
def monkeypatch_env_llamaparse_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLAMAPARSE_API_KEY", "llx-test-key")


class TestBuildLocator:
    """`build_locator` assembles the page->section->char citation anchor (sandbox ADR-4)."""

    def test_assembles_page_section_and_charspan_when_provenance_and_headings_present(
        self,
    ) -> None:
        item = _text_item("Hello world.", prov=_prov(page_no=3, char_start=10, char_end=25))
        chunk = DocChunk(
            text="Hello world.",
            meta=DocMeta(doc_items=[item], headings=["Intro", "Sub"]),
        )

        assert build_locator(chunk) == "p3:Intro > Sub:c10-25"

    def test_section_is_empty_when_the_chunk_has_no_heading_context(self) -> None:
        item = _text_item("Hello world.", prov=_prov(page_no=1, char_start=0, char_end=5))
        chunk = DocChunk(text="Hello world.", meta=DocMeta(doc_items=[item], headings=None))

        assert build_locator(chunk) == "p1::c0-5"

    def test_returns_none_when_no_doc_item_carries_provenance(self) -> None:
        item = _text_item("Non-paginated source.")
        chunk = DocChunk(
            text="Non-paginated source.", meta=DocMeta(doc_items=[item], headings=None)
        )

        assert build_locator(chunk) is None

    def test_uses_the_first_provenance_found_across_peer_merged_doc_items(self) -> None:
        without_prov = _text_item("First peer, no provenance.")
        with_prov = _text_item(
            "Second peer.", prov=_prov(page_no=2, char_start=30, char_end=42)
        )
        chunk = DocChunk(
            text="First peer, no provenance. Second peer.",
            meta=DocMeta(doc_items=[without_prov, with_prov], headings=["Section"]),
        )

        assert build_locator(chunk) == "p2:Section:c30-42"


class TestShouldUseLlamaparse:
    """`should_use_llamaparse` requires both an opt-in flag and a configured API key (Req 4.2)."""

    def test_false_when_flag_is_unset_and_no_key_is_configured(self) -> None:
        settings = get_settings()

        assert should_use_llamaparse(ParseOptions(use_llamaparse=False), settings) is False

    def test_false_when_flag_is_set_but_no_key_is_configured(self) -> None:
        settings = get_settings()

        assert should_use_llamaparse(ParseOptions(use_llamaparse=True), settings) is False

    def test_false_when_a_key_is_configured_but_the_flag_is_unset(
        self, monkeypatch_env_llamaparse_key: None
    ) -> None:
        settings = get_settings()

        assert should_use_llamaparse(ParseOptions(use_llamaparse=False), settings) is False

    def test_true_when_the_flag_is_set_and_a_key_is_configured(
        self, monkeypatch_env_llamaparse_key: None
    ) -> None:
        settings = get_settings()

        assert should_use_llamaparse(ParseOptions(use_llamaparse=True), settings) is True


class TestChunkDocument:
    """`chunk_document` maps chunker output onto the `ParsedChunk` boundary (Req 4.1/4.3)."""

    def test_maps_ordinal_source_locator_and_contextualized_text_for_every_chunk(
        self,
    ) -> None:
        doc = DoclingDocument(name="fixture")
        doc.add_heading(text="Intro", level=1, prov=_prov(page_no=1, char_start=0, char_end=5))
        doc.add_text(
            label=DocItemLabel.TEXT,
            text="Hello world.",
            prov=_prov(page_no=1, char_start=6, char_end=18),
        )
        doc.add_text(
            label=DocItemLabel.TEXT,
            text="Second paragraph.",
            prov=_prov(page_no=2, char_start=0, char_end=17),
        )
        chunker = HierarchicalChunker()

        chunks = chunk_document(doc, source="report.pdf", chunker=chunker)

        assert [c.ordinal for c in chunks] == [0, 1]
        assert all(c.source == "report.pdf" for c in chunks)
        assert chunks[0].locator == "p1:Intro:c6-18"
        assert chunks[1].locator == "p2:Intro:c0-17"
        assert chunks[0].text == "Intro\nHello world."
        assert chunks[1].text == "Intro\nSecond paragraph."

    def test_locator_is_none_for_chunks_whose_doc_items_carry_no_provenance(self) -> None:
        doc = DoclingDocument(name="fixture")
        doc.add_text(label=DocItemLabel.TEXT, text="Plain text, no page info.")
        chunker = HierarchicalChunker()

        chunks = chunk_document(doc, source="notes.txt", chunker=chunker)

        assert len(chunks) == 1
        assert chunks[0].locator is None
        assert chunks[0].source == "notes.txt"
        assert chunks[0].ordinal == 0

    def test_returns_an_empty_list_for_a_document_with_no_chunkable_content(self) -> None:
        doc = DoclingDocument(name="empty")
        chunker = HierarchicalChunker()

        assert chunk_document(doc, source="empty.pdf", chunker=chunker) == []
