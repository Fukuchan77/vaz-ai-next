"""Unit tests for `app.config` (Req 2.6 / NFR-2 / NFR-4). Network-zero: env-only, no I/O."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.config import DEFAULT_JUDGE_MODEL, JUDGE_MODEL_ALLOWLIST, get_settings

_ENV_KEYS = ("JUDGE_PROVIDER", "JUDGE_MODEL", "ANTHROPIC_API_KEY", "OLLAMA_BASE_URL")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_defaults_resolve_to_anthropic_provider_and_allowlisted_model() -> None:
    settings = get_settings()

    assert settings.judge_provider == "anthropic"
    assert settings.judge_model == DEFAULT_JUDGE_MODEL["anthropic"]
    assert settings.anthropic_api_key is None
    assert str(settings.ollama_base_url) == "http://localhost:11434/v1"


def test_unset_judge_model_falls_back_to_the_selected_providers_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "ollama")

    settings = get_settings()

    assert settings.judge_provider == "ollama"
    assert settings.judge_model == DEFAULT_JUDGE_MODEL["ollama"]


def test_explicit_allowlisted_judge_model_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "ollama")
    monkeypatch.setenv("JUDGE_MODEL", "llama3.2")

    settings = get_settings()

    assert settings.judge_model == "llama3.2"


def test_judge_model_outside_the_selected_providers_allowlist_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "anthropic")
    monkeypatch.setenv("JUDGE_MODEL", "gpt-4o")

    with pytest.raises(ValidationError, match="not in the allowlist"):
        get_settings()


def test_judge_model_valid_for_a_different_provider_is_still_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "anthropic")
    monkeypatch.setenv("JUDGE_MODEL", "llama3.2")

    with pytest.raises(ValidationError, match="not in the allowlist"):
        get_settings()


def test_unsupported_provider_is_rejected_by_the_literal_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "openai")

    with pytest.raises(ValidationError):
        get_settings()


def test_anthropic_api_key_is_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")

    settings = get_settings()

    assert settings.anthropic_api_key == "sk-test-key"


def test_ollama_base_url_override_is_validated_as_a_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.internal:11434/v1")

    settings = get_settings()

    assert str(settings.ollama_base_url) == "http://ollama.internal:11434/v1"


def test_ollama_base_url_rejects_a_non_url_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "not-a-url")

    with pytest.raises(ValidationError):
        get_settings()


def test_get_settings_is_not_cached_and_reflects_env_changes_across_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("JUDGE_PROVIDER", "anthropic")
    first = get_settings()
    assert first.judge_provider == "anthropic"

    monkeypatch.setenv("JUDGE_PROVIDER", "ollama")
    second = get_settings()

    assert second.judge_provider == "ollama"
    assert second.judge_model == DEFAULT_JUDGE_MODEL["ollama"]


def test_allowlist_only_covers_the_two_supported_providers() -> None:
    assert set(JUDGE_MODEL_ALLOWLIST.keys()) == {"anthropic", "ollama"}
    assert all(len(models) >= 1 for models in JUDGE_MODEL_ALLOWLIST.values())
