"""Fail-soft OpenTelemetry initialization and sanitized logging (Req 2.7 / NFR-3).

`services/agent` ships with only `opentelemetry-api` (a transitive dependency
of `pydantic-ai-slim`) in this phase — no SDK or OTLP exporter is bundled.
Before any code calls `opentelemetry.trace.set_tracer_provider(...)` (e.g. via
the `opentelemetry-instrument` launcher, or a future exporter dependency),
`get_tracer_provider()` returns the API's default `ProxyTracerProvider`,
whose spans are no-ops: attributes can be set and spans started without
error, simply not exported anywhere. That is exactly the fail-soft contract
Req 2.7 asks for ("service starts without collector config") and mirrors
`packages/config/src/telemetry.ts`'s "warn once, then quiet" shape on the TS
side — `init_telemetry` never raises, so a missing collector can never break
service startup.

NFR-3: `get_logger()` is the only logger `services/agent` should use for
eval/parse request handling. Call sites must log identifiers only
(`case_id`/`job_id`, model names, counts) — never raw question/answer/context
bodies. Audit persistence stays with the TS callers' `deps.audit` (no second
firing point), matching the behavioral (not type-enforced) privacy contract
documented on `Logger` in `packages/schemas/src/deps.ts`.
"""

from __future__ import annotations

import logging
from collections.abc import Generator
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Span, Tracer

_TRACER_NAME = "vaz.agent"
_SERVICE_LOGGER_NAME = "vaz.agent"

_initialized = False


def init_telemetry() -> None:
    """Detect an unconfigured OTel provider and warn once (Req 2.7, fail-soft).

    Idempotent: a second call is a no-op, so callers (e.g. `main.py` startup)
    can invoke it unconditionally without double-warning.
    """
    global _initialized
    if _initialized:
        return
    _initialized = True
    if isinstance(trace.get_tracer_provider(), trace.ProxyTracerProvider):
        get_logger().warning(
            "No OpenTelemetry SDK/exporter configured; spans are no-ops "
            "(fail-soft, Req 2.7). Configure a TracerProvider (e.g. via "
            "opentelemetry-instrument) to export spans."
        )


def get_tracer() -> Tracer:
    """Return this service's tracer (no-op until a real provider is configured)."""
    return trace.get_tracer(_TRACER_NAME)


def get_logger() -> logging.Logger:
    """Return the shared, identifier-only service logger (NFR-3)."""
    return logging.getLogger(_SERVICE_LOGGER_NAME)


@contextmanager
def traced_span(
    name: str,
    *,
    case_id: str | None = None,
    job_id: str | None = None,
    **gen_ai_attributes: str | int | float | bool,
) -> Generator[Span]:
    """Start a span carrying only sanitized correlation attributes (NFR-3).

    `case_id`/`job_id` become the `caseId`/`jobId` correlation keys shared
    with the TS side; `**gen_ai_attributes` are namespaced under `gen_ai.*`
    (Req 2.7, e.g. `model=settings.judge_model` -> `gen_ai.model`). Callers
    must pass identifiers and enumerated metadata only here — never raw
    question/answer/context text.
    """
    with get_tracer().start_as_current_span(name) as span:
        if case_id is not None:
            span.set_attribute("caseId", case_id)
        if job_id is not None:
            span.set_attribute("jobId", job_id)
        for key, value in gen_ai_attributes.items():
            span.set_attribute(f"gen_ai.{key}", value)
        yield span
