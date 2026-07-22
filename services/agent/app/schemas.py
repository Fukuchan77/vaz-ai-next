"""Pydantic boundary models for the `/eval/*` and `/parse` endpoints (Req 2.2 / 3.1 / 4.1).

This module is the single source of truth for the eval HTTP boundary's schema
(Req 3.1): FastAPI serializes these models into the OpenAPI 3.1 document that
Phase C compiles to `packages/schemas/src/generated/agent-service.ts` (ADR-B).
The TS side never redeclares these shapes by hand — it conforms a thin Zod
wrapper to the generated type — so any field added, renamed, or re-typed here
is the authoritative change, and the contract-drift test (Task 6.5) is what
catches divergence.

Field names are snake_case (Pydantic/OpenAPI idiom); the generated TS type
adopts them verbatim, so there is no need to mirror the AI SDK's camelCase
`usage` shape here — the two boundaries are bridged by the generated types,
not by matching names.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class EvalRequest(BaseModel):
    """Input shared by `POST /eval/faithfulness` and `POST /eval/relevancy` (Req 2.2).

    Both evaluators consume the same triple, forwarded to LlamaIndex's
    low-level `evaluate(query=question, response=answer, contexts=contexts)`:
    faithfulness checks whether `answer` is grounded in `contexts`, relevancy
    checks whether `answer` (and its supporting `contexts`) actually addresses
    `question`. `contexts` are the retrieved chunks — at least one is required,
    since with none there is nothing to evaluate against.
    """

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1)
    contexts: list[str] = Field(min_length=1)
    answer: str = Field(min_length=1)


class TokenUsage(BaseModel):
    """Judge-LLM token consumption for a single eval call.

    Mirrors the run-usage triple on the TS side (`@vaz/schemas`'s
    `runUsageSchema`: input/output/total) so eval cost aggregates the same way
    chat/supervisor run cost does, but named in snake_case for this Python
    boundary (the generated TS type adopts these names, ADR-B).
    """

    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)
    total_tokens: int = Field(ge=0)


class EvalResponse(BaseModel):
    """Output shared by both `/eval/*` endpoints (Req 2.2).

    `score` is LlamaIndex's `EvaluationResult.score` normalized to [0, 1];
    `verdict` is its pass/fail (`passing`); `judge_model` is the model resolved
    from `config.Settings.judge_model` (Req 2.6), echoed back so callers can
    attribute the score to a specific judge; `usage` is that judge call's token
    cost.
    """

    score: float = Field(ge=0.0, le=1.0)
    verdict: bool
    judge_model: str = Field(min_length=1)
    usage: TokenUsage


class ParseOptions(BaseModel):
    """Form field accompanying the uploaded document on `POST /parse` (Req 4.1/4.2).

    The document itself is a multipart file part (`UploadFile`, bound in
    `app.routes.parse`, Task 7.3) — Pydantic models cannot carry a file
    upload, so only the non-file option lives here. `use_llamaparse` is
    opt-in (Req 4.2): when absent or `False`, the route falls back to
    Docling's `HybridChunker` with no error; setting it `True` requires a
    LlamaParse API key to be configured (`app.config.Settings`).
    """

    model_config = ConfigDict(extra="forbid")

    use_llamaparse: bool = False


class ParsedChunk(BaseModel):
    """A single structure-preserving chunk returned by `POST /parse` (Req 4.1/4.3).

    `source` is the human-readable document identifier (mirrors
    `retrievedChunkSchema.source` on the TS side, `packages/schemas/src/rag.ts`).
    `locator` follows the page→section→char convention (sandbox ADR-4) built
    from Docling's chunk metadata (`app.parse.docling`, Task 7.2); it is
    optional because the ingest CLI's `--via-parser` path (Req 4.4) persists
    it into a **nullable** `chunk.locator` column, and non-paginated sources
    may not resolve one. `ordinal` is the chunk's position within the
    document, `text` its content — named `text` rather than the TS side's
    `content` because this is a distinct wire boundary the ingest CLI maps
    explicitly, not a shared contract (Req 3.3's thin-Zod conforming applies
    only to `/eval/*`; `/parse` is not part of the generated boundary).
    """

    model_config = ConfigDict(extra="forbid")

    source: str = Field(min_length=1)
    locator: str | None = None
    ordinal: int = Field(ge=0)
    text: str = Field(min_length=1)
