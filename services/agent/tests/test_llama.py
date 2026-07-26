"""Unit tests for `app.eval.llama` (Req 2.2 / 2.6). Network-zero throughout:
judge calls go through `pydantic_ai.models.test.TestModel`, never a real
provider — `resolve_judge_llm`'s dispatch to `AnthropicModel`/`OpenAIChatModel`
is checked structurally (right class, right model name/base_url) without
ever calling `.run()` on those models.
"""

from __future__ import annotations

import pytest
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from app.config import Settings
from app.eval.llama import (
    PydanticAIJudgeLLM,
    build_faithfulness_evaluator,
    build_relevancy_evaluator,
    map_evaluation_result,
    resolve_judge_llm,
    to_token_usage,
)


def _judge_llm(*, output_text: str) -> PydanticAIJudgeLLM:
    agent: Agent[None, str] = Agent(TestModel(custom_output_text=output_text))
    return PydanticAIJudgeLLM(agent=agent, model_name="test")


class TestPydanticAIJudgeLLMAdapter:
    async def test_achat_returns_the_agents_output_as_assistant_content(self) -> None:
        from llama_index.core.llms import ChatMessage, MessageRole

        llm = _judge_llm(output_text="YES")
        message = ChatMessage(role=MessageRole.USER, content="is this faithful?")

        response = await llm.achat([message])

        assert response.message.content == "YES"

    async def test_achat_records_the_runs_token_usage(self) -> None:
        from llama_index.core.llms import ChatMessage, MessageRole

        llm = _judge_llm(output_text="YES")
        assert llm.last_usage is None

        await llm.achat([ChatMessage(role=MessageRole.USER, content="hello")])

        assert llm.last_usage is not None
        assert llm.last_usage.input_tokens > 0

    async def test_to_token_usage_passes_through_the_runs_reported_values(self) -> None:
        """`to_token_usage` mirrors the run's own token counts (Req 4.2)
        rather than recomputing them, so `total_tokens` in particular is
        `llm.last_usage.total_tokens` itself, not a local `input + output`.
        With cache tokens at 0 (`TestModel`'s usage) the two happen to
        coincide — `test_to_token_usage_does_not_recompute_the_total_from_input_and_output`
        below is what actually exercises the pass-through-vs-recompute
        distinction.
        """
        from llama_index.core.llms import ChatMessage, MessageRole

        llm = _judge_llm(output_text="YES")
        await llm.achat([ChatMessage(role=MessageRole.USER, content="hello")])
        assert llm.last_usage is not None

        usage = to_token_usage(llm.last_usage)

        assert usage.input_tokens == llm.last_usage.input_tokens
        assert usage.output_tokens == llm.last_usage.output_tokens
        assert usage.total_tokens == llm.last_usage.total_tokens

    def test_to_token_usage_does_not_recompute_the_total_from_input_and_output(self) -> None:
        """On the pinned `pydantic-ai` version, `RunUsage.total_tokens` is
        defined as exactly `input_tokens + output_tokens` (`input_tokens`
        already folds in `cache_read_tokens`/`cache_write_tokens` upstream),
        so no real `RunUsage` can make the two diverge — there is no
        provider response to construct that would fail a naive
        `input + output` recomputation. This test double overrides
        `total_tokens` to simulate a future version where it doesn't, and
        proves `to_token_usage` reads `usage.total_tokens` verbatim rather
        than recomputing it locally, so such a future change is reflected
        here without a code edit.
        """

        class _DivergingTotalUsage(RunUsage):
            @property
            def total_tokens(self) -> int:
                return self.input_tokens + self.output_tokens + 1_000

        usage = _DivergingTotalUsage(input_tokens=5, output_tokens=3, cache_read_tokens=2)

        result = to_token_usage(usage)

        assert result.input_tokens == 5
        assert result.output_tokens == 3
        assert result.total_tokens == 1_008

    def test_metadata_reports_the_model_name_and_chat_capability(self) -> None:
        llm = _judge_llm(output_text="YES")

        assert llm.metadata.model_name == "test"
        assert llm.metadata.is_chat_model is True

    def test_sync_chat_is_not_supported(self) -> None:
        llm = _judge_llm(output_text="YES")

        with pytest.raises(NotImplementedError):
            llm.chat([])

    def test_sync_complete_is_not_supported(self) -> None:
        llm = _judge_llm(output_text="YES")

        with pytest.raises(NotImplementedError):
            llm.complete("prompt")

    def test_sync_stream_complete_is_not_supported(self) -> None:
        llm = _judge_llm(output_text="YES")

        with pytest.raises(NotImplementedError):
            list(llm.stream_complete("prompt"))


class TestMapEvaluationResult:
    def test_a_passing_result_maps_to_its_score_and_true(self) -> None:
        from llama_index.core.evaluation.base import EvaluationResult

        result = EvaluationResult(passing=True, score=1.0, invalid_result=False)

        assert map_evaluation_result(result) == (1.0, True)

    def test_a_failing_result_maps_to_its_score_and_false(self) -> None:
        from llama_index.core.evaluation.base import EvaluationResult

        result = EvaluationResult(passing=False, score=0.0, invalid_result=False)

        assert map_evaluation_result(result) == (0.0, False)

    def test_an_invalid_result_raises_instead_of_silently_defaulting(self) -> None:
        from llama_index.core.evaluation.base import EvaluationResult

        result = EvaluationResult(
            passing=None, score=None, invalid_result=True, invalid_reason="malformed judge output"
        )

        with pytest.raises(ValueError, match="malformed judge output"):
            map_evaluation_result(result)

    def test_a_result_missing_passing_or_score_raises(self) -> None:
        from llama_index.core.evaluation.base import EvaluationResult

        result = EvaluationResult(passing=None, score=1.0, invalid_result=False)

        with pytest.raises(ValueError, match="did not set passing/score"):
            map_evaluation_result(result)


class TestBuildFaithfulnessEvaluator:
    async def test_a_yes_verdict_from_the_judge_passes(self) -> None:
        llm = _judge_llm(output_text="YES")
        evaluator = build_faithfulness_evaluator(llm)

        result = await evaluator.aevaluate(
            response="Paris is the capital of France.",
            contexts=["Paris is the capital city of France."],
        )

        assert result.passing is True
        assert result.invalid_result is False

    async def test_a_no_verdict_from_the_judge_fails_without_raising(self) -> None:
        llm = _judge_llm(output_text="NO")
        evaluator = build_faithfulness_evaluator(llm)

        result = await evaluator.aevaluate(
            response="The moon is made of cheese.",
            contexts=["The moon is composed primarily of rock."],
        )

        assert result.passing is False


class TestBuildRelevancyEvaluator:
    async def test_a_yes_verdict_from_the_judge_passes(self) -> None:
        llm = _judge_llm(output_text="YES")
        evaluator = build_relevancy_evaluator(llm)

        result = await evaluator.aevaluate(
            query="What is the capital of France?",
            response="Paris is the capital of France.",
            contexts=["Paris is the capital city of France."],
        )

        assert result.passing is True

    async def test_a_no_verdict_from_the_judge_fails_without_raising(self) -> None:
        llm = _judge_llm(output_text="NO")
        evaluator = build_relevancy_evaluator(llm)

        result = await evaluator.aevaluate(
            query="What is the capital of France?",
            response="Bananas are yellow.",
            contexts=["Paris is the capital city of France."],
        )

        assert result.passing is False


class TestResolveJudgeLlm:
    def test_anthropic_provider_resolves_to_an_anthropic_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("JUDGE_PROVIDER", "anthropic")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        settings = Settings()

        llm = resolve_judge_llm(settings)

        assert isinstance(llm.agent.model, AnthropicModel)
        assert llm.agent.model.model_name == settings.judge_model
        assert llm.metadata.model_name == settings.judge_model

    def test_anthropic_provider_without_an_api_key_fails_loud(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("JUDGE_PROVIDER", "anthropic")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        settings = Settings()

        with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
            resolve_judge_llm(settings)

    def test_ollama_provider_resolves_to_an_openai_compatible_model(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("JUDGE_PROVIDER", "ollama")
        monkeypatch.setenv("OLLAMA_BASE_URL", "http://ollama.internal:11434/v1")
        settings = Settings()

        llm = resolve_judge_llm(settings)

        assert isinstance(llm.agent.model, OpenAIChatModel)
        assert llm.agent.model.model_name == settings.judge_model
        assert str(settings.ollama_base_url) in str(llm.agent.model.client.base_url)

    def test_ollama_provider_requires_no_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("JUDGE_PROVIDER", "ollama")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        settings = Settings()

        resolve_judge_llm(settings)  # must not raise
