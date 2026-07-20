"""FastAPI application entrypoint for the agent service (Req 2.1 / 2.3).

Stateless: this module and its startup path never touch a database, Redis,
or the filesystem (Req 2.3) — every input a future route needs arrives in
the request itself. Route modules (`/eval/*` in Task 5, `/parse` in Task 7)
register themselves onto `app` as they land; this module owns only app
construction, `/healthz`, and the fail-soft telemetry startup hook (Req 2.7).
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.telemetry import init_telemetry


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    init_telemetry()
    yield


app = FastAPI(title="vaz-agent-service", lifespan=_lifespan)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness probe; touches no external dependency (Req 2.3)."""
    return {"status": "ok"}
