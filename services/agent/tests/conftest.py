"""Shared pytest fixtures for `services/agent` tests (Req 2.4).

`async_client` wires an `httpx.AsyncClient` to `app.main.app` via
`httpx.ASGITransport`: requests are dispatched in-process through the ASGI
app itself, so `/eval/*` route tests (Task 5.5) exercise the real FastAPI
routing/validation stack without ever opening a socket (network-zero).

`judge_llm_factory`/`deterministic_judge_llm` build a `PydanticAIJudgeLLM`
backed by `pydantic_ai.models.test.TestModel` — the same deterministic-fake
pattern `tests/test_llama.py`'s `_judge_llm` helper already uses for the
evaluator-wrapper unit tests, exposed here as a shared fixture so route tests
can inject a fixed judge verdict via `app.dependency_overrides` (Task 5.4
defines the judge dependency the override targets) instead of ever calling a
real provider.

`_clear_dependency_overrides` resets `app.dependency_overrides` after every
test so a per-test override (e.g. a route test forcing a "NO" verdict) never
leaks into the next test.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable, Iterator

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from app.eval.llama import PydanticAIJudgeLLM
from app.main import app


@pytest.fixture
async def async_client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest.fixture
def judge_llm_factory() -> Callable[[str], PydanticAIJudgeLLM]:
    def _build(output_text: str) -> PydanticAIJudgeLLM:
        agent: Agent[None, str] = Agent(TestModel(custom_output_text=output_text))
        return PydanticAIJudgeLLM(agent=agent, model_name="test")

    return _build


@pytest.fixture
def deterministic_judge_llm(
    judge_llm_factory: Callable[[str], PydanticAIJudgeLLM],
) -> PydanticAIJudgeLLM:
    return judge_llm_factory("YES")


@pytest.fixture(autouse=True)
def _clear_dependency_overrides() -> Iterator[None]:  # pyright: ignore[reportUnusedFunction]
    yield
    app.dependency_overrides.clear()
