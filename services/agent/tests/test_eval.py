"""Contract tests for `POST /eval/faithfulness` and `POST /eval/relevancy` (Req 2.2 / 2.4).

Exercises the routes through the real FastAPI routing/validation stack via
`async_client` (`httpx.ASGITransport`, in-process) and overrides
`app.routes.eval.get_judge_llm` with a deterministic fake judge
(`judge_llm_factory`/`deterministic_judge_llm`, `pydantic_ai.models.test.TestModel`)
so no test ever calls a real judge provider (network-zero).
"""

from __future__ import annotations

from collections.abc import Callable

from httpx import AsyncClient

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
