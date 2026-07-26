"""`POST /eval/faithfulness` and `POST /eval/relevancy` (Req 2.2).

Both routes share the same `EvalRequest`/`EvalResponse` boundary
(`app.schemas`) and judge resolution: `get_judge_llm` builds a
`PydanticAIJudgeLLM` from the current `Settings` (Req 2.6) as a FastAPI
dependency, so route tests (Task 5.5) can substitute a deterministic fake via
`app.dependency_overrides[get_judge_llm]` instead of ever resolving a real
provider (Req 2.4, network-zero).

Faithfulness checks whether `answer` is grounded in `contexts` alone
(`query` is not part of that judgment); relevancy checks whether `answer`
(given `contexts`) actually addresses `question`, so it is passed as
`query` (plan.md's `/eval/*` interface table).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.config import get_settings
from app.eval.llama import (
    PydanticAIJudgeLLM,
    build_faithfulness_evaluator,
    build_relevancy_evaluator,
    map_evaluation_result,
    resolve_judge_llm,
    to_token_usage,
)
from app.schemas import EvalRequest, EvalResponse

router = APIRouter(prefix="/eval", tags=["eval"])


def get_judge_llm() -> PydanticAIJudgeLLM:
    """Resolve the judge LLM for the current request (Req 2.6).

    Overridable via `app.dependency_overrides[get_judge_llm]` in tests.
    """
    return resolve_judge_llm(get_settings())


@router.post("/faithfulness", response_model=EvalResponse)
async def faithfulness(
    body: EvalRequest, judge: PydanticAIJudgeLLM = Depends(get_judge_llm)
) -> EvalResponse:
    evaluator = build_faithfulness_evaluator(judge)
    result = await evaluator.aevaluate(response=body.answer, contexts=body.contexts)
    score, verdict = map_evaluation_result(result)
    usage = judge.last_usage
    if usage is None:
        raise RuntimeError("achat records usage on every aevaluate() call")
    return EvalResponse(
        score=score,
        verdict=verdict,
        judge_model=judge.model_name,
        usage=to_token_usage(usage),
    )


@router.post("/relevancy", response_model=EvalResponse)
async def relevancy(
    body: EvalRequest, judge: PydanticAIJudgeLLM = Depends(get_judge_llm)
) -> EvalResponse:
    evaluator = build_relevancy_evaluator(judge)
    result = await evaluator.aevaluate(
        query=body.question, response=body.answer, contexts=body.contexts
    )
    score, verdict = map_evaluation_result(result)
    usage = judge.last_usage
    if usage is None:
        raise RuntimeError("achat records usage on every aevaluate() call")
    return EvalResponse(
        score=score,
        verdict=verdict,
        judge_model=judge.model_name,
        usage=to_token_usage(usage),
    )
