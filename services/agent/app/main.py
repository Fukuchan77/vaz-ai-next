"""FastAPI application entrypoint for the agent service (Req 2.1 / 2.3).

Stateless: this module and its startup path never touch a database, Redis,
or the filesystem (Req 2.3) — every input a future route needs arrives in
the request itself. Route modules (`/eval/*` in Task 5, `/parse` in Task 7)
are registered here via `include_router` as they land; this module owns app
construction, `/healthz`, and the fail-soft telemetry startup hook (Req 2.7).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.routes.eval import router as eval_router
from app.routes.parse import router as parse_router
from app.telemetry import init_telemetry


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    init_telemetry()
    yield


app = FastAPI(title="vaz-agent-service", lifespan=_lifespan)
app.include_router(eval_router)
app.include_router(parse_router)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe; touches no external dependency (Req 2.3)."""
    return {"status": "ok"}
