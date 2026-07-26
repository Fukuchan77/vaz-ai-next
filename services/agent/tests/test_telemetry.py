"""Unit tests for `app.telemetry` (Req 2.7 / NFR-3). Network-zero: OTel API + stdlib logging."""

from __future__ import annotations

import logging
from collections.abc import Generator
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

from app import telemetry


@pytest.fixture(autouse=True)
def _reset_telemetry_state() -> Generator[None]:  # pyright: ignore[reportUnusedFunction]
    telemetry._initialized = False  # pyright: ignore[reportPrivateUsage]
    yield
    telemetry._initialized = False  # pyright: ignore[reportPrivateUsage]


class _StubTracer:
    """A tracer double that records `set_attribute` calls without touching the real OTel API."""

    def __init__(self) -> None:
        self.span = MagicMock()

    @contextmanager
    def start_as_current_span(self, name: str) -> Generator[MagicMock]:
        yield self.span


def test_init_telemetry_warns_once_without_a_configured_provider(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="vaz.agent"):
        telemetry.init_telemetry()
        telemetry.init_telemetry()

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1


def test_init_telemetry_never_raises_without_a_collector() -> None:
    telemetry.init_telemetry()


def test_get_tracer_returns_a_working_tracer() -> None:
    tracer = telemetry.get_tracer()
    with tracer.start_as_current_span("smoke") as span:
        assert span is not None


def test_traced_span_sets_sanitized_correlation_and_gen_ai_attributes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stub = _StubTracer()
    monkeypatch.setattr(telemetry, "get_tracer", lambda: stub)

    with telemetry.traced_span(
        "eval.faithfulness", case_id="case-1", job_id="job-1", model="claude-opus-4-8"
    ):
        pass

    stub.span.set_attribute.assert_any_call("caseId", "case-1")
    stub.span.set_attribute.assert_any_call("jobId", "job-1")
    stub.span.set_attribute.assert_any_call("gen_ai.model", "claude-opus-4-8")


def test_traced_span_omits_missing_correlation_ids(monkeypatch: pytest.MonkeyPatch) -> None:
    stub = _StubTracer()
    monkeypatch.setattr(telemetry, "get_tracer", lambda: stub)

    with telemetry.traced_span("eval.relevancy"):
        pass

    called_keys = {call.args[0] for call in stub.span.set_attribute.call_args_list}
    assert "caseId" not in called_keys
    assert "jobId" not in called_keys


def test_get_logger_returns_the_shared_service_logger() -> None:
    logger = telemetry.get_logger()
    assert logger.name == "vaz.agent"
