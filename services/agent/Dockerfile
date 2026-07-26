# syntax=docker/dockerfile:1

# services/agent — stateless Python sidecar (eval + parse), dev/local use only.
#
# Opt-in via the compose `sidecar` profile (`docker compose --profile sidecar
# up -d`): the image is heavy (Docling pulls torch), so the default
# `docker compose up -d` never builds it. Production containerization remains
# deferred (spec 002 ADR-C / spec 004 ledger) — this image exists so the
# locator-citation E2E, `--via-parser` ingest, and tier2 evals have a
# one-command local `/parse` + `/eval/*` endpoint.
#
# uv owns dependency resolution (uv.lock is the source of truth); the deps
# layer is synced before the app source is copied so code edits don't
# re-resolve the (large) dependency set.

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /srv/agent

# Compile bytecode for faster cold starts; keep the venv inside the image.
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app

# Drop privileges: the sidecar is stateless (no DB/Redis/filesystem writes).
RUN useradd --system --no-create-home agent
USER agent

EXPOSE 8000
CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
