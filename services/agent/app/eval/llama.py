"""Judge-injected LlamaIndex evaluator wrappers (Req 2.2 / 2.6).

LlamaIndex's low-level `evaluate`/`aevaluate` API (used instead of the
high-level `evaluate_response`, which assumes a `QueryEngine`, per
research.md ADR item 3) requires an injected `llama_index.core.llms.LLM` as
the judge. This module resolves that judge from `app.config.Settings`
(`judge_provider`/`judge_model`, itself allowlist-checked — NFR-2) and
bridges it to LlamaIndex's `LLM` protocol via Pydantic AI's `Agent`, the
project's typed foundation for judge calls (research.md tech-stack table).

`PydanticAIJudgeLLM` is async-only: `FaithfulnessEvaluator`/
`RelevancyEvaluator.aevaluate` exclusively call `apredict` -> `achat` (their
`is_chat_model=True` means `acomplete` is never reached), and `achat` here
awaits `Agent.run` directly. The sync `chat`/`complete`/`stream_complete`
methods (still required to satisfy the `CustomLLM` ABC) raise
`NotImplementedError` rather than bridging via `asyncio.run()`, which would
deadlock when called from within the running event loop every FastAPI async
route handler provides.
"""

from __future__ import annotations

from collections.abc import Generator, Sequence
from typing import Any, assert_never

from llama_index.core.evaluation import FaithfulnessEvaluator, RelevancyEvaluator
from llama_index.core.evaluation.base import EvaluationResult
from llama_index.core.llms import (
    LLM,
    ChatMessage,
    ChatResponse,
    CompletionResponse,
    CustomLLM,
    LLMMetadata,
    MessageRole,
)
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RunUsage

from app.config import Settings
from app.schemas import TokenUsage


class PydanticAIJudgeLLM(CustomLLM):
    """Adapts a Pydantic AI `Agent` as a judge `LLM` for LlamaIndex evaluators.

    `last_usage` records the most recent `achat` call's token cost so a
    caller (the `/eval/*` route, Task 5.4) can build the boundary's
    `TokenUsage` after `aevaluate()` returns — `EvaluationResult` itself
    carries no usage.

    `agent` is typed `Any`, not `Agent[None, str]`: `CustomLLM`/`LLM` are
    themselves pydantic models, and a precisely-typed `Agent` field makes
    pydantic recurse into `Agent`'s own (and pydantic-graph's) dataclass
    fields to build a validation schema — which, at least on the versions
    pinned here, dies on an unresolved forward reference deep in that
    dependency chain. `arbitrary_types_allowed` (already set on the `LLM`
    base) does not help, because pydantic still models known dataclasses
    structurally rather than treating them as opaque. Callers always pass
    a real `Agent[None, str]` (see `resolve_judge_llm`/tests); only the
    pydantic field annotation is loosened.
    """

    agent: Any
    model_name: str
    last_usage: RunUsage | None = None

    @property
    def metadata(self) -> LLMMetadata:
        return LLMMetadata(model_name=self.model_name, is_chat_model=True)

    async def achat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponse:
        del kwargs
        prompt = "\n\n".join(message.content or "" for message in messages)
        result = await self.agent.run(prompt)
        self.last_usage = result.usage
        return ChatResponse(message=ChatMessage(role=MessageRole.ASSISTANT, content=result.output))

    def complete(self, prompt: str, formatted: bool = False, **kwargs: Any) -> CompletionResponse:
        del prompt, formatted, kwargs
        raise NotImplementedError(
            "PydanticAIJudgeLLM is async-only: use the evaluator's aevaluate(), "
            "not the sync evaluate()."
        )

    def stream_complete(
        self, prompt: str, formatted: bool = False, **kwargs: Any
    ) -> Generator[CompletionResponse]:
        del prompt, formatted, kwargs
        raise NotImplementedError("PydanticAIJudgeLLM does not support streaming.")

    @classmethod
    def class_name(cls) -> str:
        return "pydantic_ai_judge_llm"


def resolve_judge_llm(settings: Settings) -> PydanticAIJudgeLLM:
    """Build the judge adapter for `settings.judge_provider` (Req 2.6).

    Fails loud at construction (not at the first `aevaluate()` call) when a
    provider's required credential is missing, since surfacing that from
    deep inside a request would be a worse debugging experience.
    """
    judge_model = settings.judge_model
    assert judge_model is not None, "Settings always resolves a default judge_model"

    if settings.judge_provider == "anthropic":
        if not settings.anthropic_api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY is required when JUDGE_PROVIDER=anthropic "
                "(set it, or switch JUDGE_PROVIDER=ollama for a local judge)."
            )
        provider = AnthropicProvider(api_key=settings.anthropic_api_key)
        model = AnthropicModel(judge_model, provider=provider)
    elif settings.judge_provider == "ollama":
        model = OpenAIChatModel(
            judge_model,
            provider=OpenAIProvider(base_url=str(settings.ollama_base_url), api_key="ollama"),
        )
    else:
        assert_never(settings.judge_provider)

    agent: Agent[None, str] = Agent(model)
    return PydanticAIJudgeLLM(agent=agent, model_name=judge_model)


def build_faithfulness_evaluator(llm: LLM) -> FaithfulnessEvaluator:
    """Wrap `llm` in a `FaithfulnessEvaluator` that reports failure as a
    verdict, not an exception (Req 2.2 — a `NO` judge answer is a normal
    `{score, verdict}` response, not a 5xx)."""
    return FaithfulnessEvaluator(llm=llm, raise_error=False)


def build_relevancy_evaluator(llm: LLM) -> RelevancyEvaluator:
    """Wrap `llm` in a `RelevancyEvaluator` with the same non-raising contract
    as `build_faithfulness_evaluator` (Req 2.2)."""
    return RelevancyEvaluator(llm=llm, raise_error=False)


def map_evaluation_result(result: EvaluationResult) -> tuple[float, bool]:
    """Map a LlamaIndex `EvaluationResult` to the boundary's `(score, verdict)`.

    Fails loud rather than silently defaulting when the judge produced an
    invalid result or, unexpectedly, omitted `passing`/`score` on a result
    it did not itself mark invalid.
    """
    if result.invalid_result:
        reason = result.invalid_reason or "no reason given"
        raise ValueError(f"Judge produced an invalid evaluation result: {reason}")
    if result.passing is None or result.score is None:
        raise ValueError(
            "Judge evaluator did not set passing/score on a valid result "
            "(expected FaithfulnessEvaluator/RelevancyEvaluator invariant)"
        )
    return result.score, result.passing


def to_token_usage(usage: RunUsage) -> TokenUsage:
    """Convert a Pydantic AI run usage into the eval boundary's `TokenUsage`.

    Reads `usage.total_tokens` (provider-reported) rather than recomputing
    `input_tokens + output_tokens` locally, so this boundary always
    reflects whatever `total_tokens` means on the resolved `pydantic-ai`
    version instead of hardcoding an assumption about it here. On the
    pinned version, `RunUsage.total_tokens` is defined as exactly
    `input_tokens + output_tokens` (`input_tokens` itself already folds in
    `cache_read_tokens`/`cache_write_tokens` upstream), so this equals the
    previously-recomputed value — the distinction only matters if a future
    version redefines `total_tokens` to include something outside
    `input_tokens + output_tokens` (e.g. separately-tracked reasoning
    tokens), in which case this boundary follows without a code change.
    """
    return TokenUsage(
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        total_tokens=usage.total_tokens,
    )
