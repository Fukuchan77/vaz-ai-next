"""Environment-validated settings for the agent service (Req 2.6 / NFR-2 / NFR-4).

Judge-model selection is read from the environment and checked against an
in-file allowlist. This module is the single legitimate place for hardcoded
judge model-ID literals in `services/**` — `scripts/forbid-model-ids.sh`
carves it out of its scan (NFR-2); every other module must resolve the model
ID through `Settings.judge_model`, never as a literal. Mirrors the
`packages/config/src/model-allowlist.ts` pattern on the TS side (ADR-5).

Only the `anthropic` and `ollama` providers are supported, matching the
provider-agnostic, no-OpenAI constitution principle already enforced on the
TS side (`@vaz/schemas/env#aiEnvSchema`).
"""

from __future__ import annotations

from typing import Literal

from pydantic import AnyHttpUrl, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

JudgeProvider = Literal["anthropic", "ollama"]

JUDGE_MODEL_ALLOWLIST: dict[JudgeProvider, tuple[str, ...]] = {
    "anthropic": ("claude-opus-4-8",),
    "ollama": ("llama3.2",),
}

DEFAULT_JUDGE_MODEL: dict[JudgeProvider, str] = {
    provider: models[0] for provider, models in JUDGE_MODEL_ALLOWLIST.items()
}


class Settings(BaseSettings):
    """Process-wide settings, validated once from the environment at startup."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    judge_provider: JudgeProvider = "anthropic"
    judge_model: str | None = None
    anthropic_api_key: str | None = None
    ollama_base_url: AnyHttpUrl = AnyHttpUrl("http://localhost:11434/v1")

    llamaparse_api_key: str | None = None
    """Gates `/parse`'s LlamaParse opt-in (Req 4.2): unset means the parse path always
    falls back to Docling with no error, regardless of a request's `use_llamaparse` flag
    (`app.parse.docling.should_use_llamaparse`)."""

    @model_validator(mode="after")
    def _resolve_and_validate_judge_model(self) -> Settings:
        allowed = JUDGE_MODEL_ALLOWLIST[self.judge_provider]
        if self.judge_model is None:
            self.judge_model = DEFAULT_JUDGE_MODEL[self.judge_provider]
        elif self.judge_model not in allowed:
            raise ValueError(
                f"judge_model {self.judge_model!r} is not in the allowlist for "
                f"provider {self.judge_provider!r}: {allowed}"
            )
        return self


def get_settings() -> Settings:
    """Construct `Settings` from the current environment.

    Resolved per call (not cached) to match the TS side's per-request provider
    resolution pattern (`@vaz/config#resolveModel`), so env changes take effect
    without a process restart.
    """
    return Settings()
