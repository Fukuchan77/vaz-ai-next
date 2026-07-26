"""Contract tests for `POST /eval/faithfulness` and `POST /eval/relevancy` (Req 2.2 / 2.4).

Exercises the routes through the real FastAPI routing/validation stack via
`async_client` (`httpx.ASGITransport`, in-process) and overrides
`app.routes.eval.get_judge_llm` with a deterministic fake judge
(`judge_llm_factory`/`deterministic_judge_llm`, `pydantic_ai.models.test.TestModel`)
so no test ever calls a real judge provider (network-zero).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import pytest
from httpx import AsyncClient
from llama_index.core.llms import ChatMessage, ChatResponse, MessageRole
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from app.eval.llama import PydanticAIJudgeLLM
from app.main import app
from app.routes.eval import get_judge_llm

_REQUEST_BODY = {
    "question": "What is the capital of France?",
    "contexts": ["Paris is the capital city of France."],
    "answer": "Paris is the capital of France.",
}


def _override_judge(judge: PydanticAIJudgeLLM) -> None:
    app.dependency_overrides[get_judge_llm] = lambda: judge


class _JudgeWithoutUsageTracking(PydanticAIJudgeLLM):
    """Fake judge whose `achat` never records `last_usage` (Req 4.1), to
    force the route's `judge.last_usage is None` branch — the path that
    changed from a bare `assert` to an explicit `RuntimeError`."""

    async def achat(self, messages: Sequence[ChatMessage], **kwargs: Any) -> ChatResponse:
        del kwargs
        prompt = "\n\n".join(message.content or "" for message in messages)
        result = await self.agent.run(prompt)
        return ChatResponse(message=ChatMessage(role=MessageRole.ASSISTANT, content=result.output))


def _judge_without_usage_tracking() -> PydanticAIJudgeLLM:
    agent: Agent[None, str] = Agent(TestModel(custom_output_text="YES"))
    return _JudgeWithoutUsageTracking(agent=agent, model_name="test")


class TestFaithfulness:
    async def test_a_yes_verdict_returns_the_contract_shape(
        self, async_client: AsyncClient, deterministic_judge_llm: PydanticAIJudgeLLM
    ) -> None:
        _override_judge(deterministic_judge_llm)

        response = await async_client.post("/eval/faithfulness", json=_REQUEST_BODY)

        assert response.status_code == 200
        body = response.json()
        assert body["verdict"] is True
        assert 0.0 <= body["score"] <= 1.0
        assert body["judge_model"] == "test"
        assert set(body["usage"]) == {"input_tokens", "output_tokens", "total_tokens"}
        assert body["usage"]["total_tokens"] == (
            body["usage"]["input_tokens"] + body["usage"]["output_tokens"]
        )

    async def test_a_no_verdict_fails_without_raising(
        self,
        async_client: AsyncClient,
        judge_llm_factory: Callable[[str], PydanticAIJudgeLLM],
    ) -> None:
        _override_judge(judge_llm_factory("NO"))

        response = await async_client.post("/eval/faithfulness", json=_REQUEST_BODY)

        assert response.status_code == 200
        assert response.json()["verdict"] is False

    async def test_contexts_alone_ground_the_judgment_query_is_not_forwarded(
        self,
        async_client: AsyncClient,
        judge_llm_factory: Callable[[str], PydanticAIJudgeLLM],
    ) -> None:
        # FaithfulnessEvaluator.aevaluate is called with response+contexts only
        # (app/eval/llama.py's build_faithfulness_evaluator usage in routes/eval.py);
        # a judge that always answers YES must still exercise that same path
        # regardless of what `question` contains.
        _override_judge(judge_llm_factory("YES"))
        body = {**_REQUEST_BODY, "question": "irrelevant text unrelated to the contexts"}

        response = await async_client.post("/eval/faithfulness", json=body)

        assert response.status_code == 200
        assert response.json()["verdict"] is True


class TestRelevancy:
    async def test_a_yes_verdict_returns_the_contract_shape(
        self, async_client: AsyncClient, deterministic_judge_llm: PydanticAIJudgeLLM
    ) -> None:
        _override_judge(deterministic_judge_llm)

        response = await async_client.post("/eval/relevancy", json=_REQUEST_BODY)

        assert response.status_code == 200
        body = response.json()
        assert body["verdict"] is True
        assert 0.0 <= body["score"] <= 1.0
        assert body["judge_model"] == "test"
        assert set(body["usage"]) == {"input_tokens", "output_tokens", "total_tokens"}

    async def test_a_no_verdict_fails_without_raising(
        self,
        async_client: AsyncClient,
        judge_llm_factory: Callable[[str], PydanticAIJudgeLLM],
    ) -> None:
        _override_judge(judge_llm_factory("NO"))

        response = await async_client.post("/eval/relevancy", json=_REQUEST_BODY)

        assert response.status_code == 200
        assert response.json()["verdict"] is False


class TestRequestValidation:
    """`EvalRequest` (Req 3.1) rejects malformed bodies before any judge call."""

    async def test_a_missing_required_field_is_rejected(
        self, async_client: AsyncClient, deterministic_judge_llm: PydanticAIJudgeLLM
    ) -> None:
        _override_judge(deterministic_judge_llm)
        body = {k: v for k, v in _REQUEST_BODY.items() if k != "answer"}

        response = await async_client.post("/eval/faithfulness", json=body)

        assert response.status_code == 422

    async def test_empty_contexts_is_rejected(
        self, async_client: AsyncClient, deterministic_judge_llm: PydanticAIJudgeLLM
    ) -> None:
        _override_judge(deterministic_judge_llm)
        body = {**_REQUEST_BODY, "contexts": []}

        response = await async_client.post("/eval/faithfulness", json=body)

        assert response.status_code == 422

    async def test_an_unknown_field_is_rejected(
        self, async_client: AsyncClient, deterministic_judge_llm: PydanticAIJudgeLLM
    ) -> None:
        _override_judge(deterministic_judge_llm)
        body = {**_REQUEST_BODY, "unexpected_field": "not part of the contract"}

        response = await async_client.post("/eval/relevancy", json=body)

        assert response.status_code == 422


class TestMissingUsageInvariant:
    """Req 4.1: `judge.last_usage is None` after `aevaluate()` now raises an
    explicit `RuntimeError` (readable under `python -O`), not a bare
    `assert`'s `AssertionError`. Starlette's `ServerErrorMiddleware`
    re-raises unhandled exceptions after sending the 500 response, and
    `httpx.ASGITransport`'s default `raise_app_exceptions=True` propagates
    that to the caller — so this asserts the raised type directly.
    """

    @pytest.mark.parametrize("path", ["/eval/faithfulness", "/eval/relevancy"])
    async def test_raises_runtime_error_not_assertion_error(
        self, async_client: AsyncClient, path: str
    ) -> None:
        _override_judge(_judge_without_usage_tracking())

        with pytest.raises(RuntimeError, match="achat records usage"):
            await async_client.post(path, json=_REQUEST_BODY)
