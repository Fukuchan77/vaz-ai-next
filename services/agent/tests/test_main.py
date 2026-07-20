"""Unit tests for `app.main` (Req 2.1 / 2.3). Network-zero: in-process ASGI via `TestClient`."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import main


def test_healthz_returns_ok_without_touching_any_external_dependency() -> None:
    with TestClient(main.app) as client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_lifespan_initializes_telemetry_on_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    def _fake_init_telemetry() -> None:
        nonlocal calls
        calls += 1

    monkeypatch.setattr(main, "init_telemetry", _fake_init_telemetry)

    with TestClient(main.app):
        pass

    assert calls == 1
