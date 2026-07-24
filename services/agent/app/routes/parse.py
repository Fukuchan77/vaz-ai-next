"""`POST /parse` — structure-preserving document parsing (Req 4.1/4.2).

Accepts a multipart upload: `file` is the document itself (a raw file
part), `use_llamaparse` the accompanying opt-in flag. Both travel as
separate multipart parts (`python-multipart` backs FastAPI's form/file
parsing here); `use_llamaparse` is bound as a plain scalar `Form()` field
rather than the `ParseOptions` model (`app.schemas`, Task 7.1) directly,
because FastAPI embeds a Pydantic Form-model parameter under its own key
(`{"options": {...}}`) once another body-like parameter — here, `File` —
is present on the same route, which would require callers to send an
`options` part as JSON instead of the flat field plan.md's HTTP boundary
table describes.

The route always converts through Docling
(`app.parse.docling.convert_document`/`chunk_document`, Req 4.1's default)
unless `should_use_llamaparse` resolves `True` (flag set + API key
configured). Actual LlamaParse invocation has no implementation in this
phase (`app.parse.docling`'s module docstring), so that branch fails loudly
with `501 Not Implemented` rather than silently falling back to Docling —
a silent fallback there would contradict the caller's explicit opt-in and
configured key. Req 4.2's SHALL ("fall back to Docling with no error") only
covers the *unconfigured* case (flag absent, or no key): that path is
unaffected and still converts through Docling with no error, as before.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile

from app.config import Settings, get_settings
from app.parse.docling import chunk_document, convert_document, should_use_llamaparse
from app.schemas import ParsedChunk, ParseOptions

router = APIRouter(tags=["parse"])


@router.post("/parse", response_model=list[ParsedChunk])
async def parse_document(
    file: UploadFile,
    use_llamaparse: Annotated[bool, Form()] = False,
    settings: Settings = Depends(get_settings),
) -> list[ParsedChunk]:
    options = ParseOptions(use_llamaparse=use_llamaparse)
    if should_use_llamaparse(options, settings):
        raise HTTPException(
            status_code=501,
            detail="LlamaParse is configured (use_llamaparse=true + an API key) but not yet "
            "implemented; omit use_llamaparse to parse this document with Docling.",
        )
    content = await file.read()
    source = file.filename or "untitled"
    dl_doc = convert_document(filename=source, content=content)
    return chunk_document(dl_doc, source=source)
