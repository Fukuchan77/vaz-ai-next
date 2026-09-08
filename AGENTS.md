# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands

Tasks are managed via **mise**. Always check [`mise.toml`](mise.toml) for available tasks.

| Action                 | Command                    |
| ---------------------- | -------------------------- |
| Dev server (Turbopack) | `mise run dev`             |
| Build                  | `mise run build`           |
| Unit tests (once)      | `mise run test:run`        |
| E2E tests              | `mise run test:e2e`        |
| E2E vs local Ollama    | `mise run test:e2e:ollama` |
| Lint check             | `mise run lint`            |
| Lint + format fix      | `mise run lint:fix`        |
| Type check             | `mise run typecheck`       |
| Aggregate gate         | `mise run check`           |

Direct pnpm equivalents (when mise is unavailable):

- `pnpm exec vitest run` — run all unit tests once
- `pnpm exec vitest run --project web apps/web/tests/chat-route.spec.ts` — run a single web (jsdom) test
- `pnpm exec vitest run --project packages packages/agents/tests/chat-agent.spec.ts` — run a single package test
- `pnpm exec vitest run --project packages packages/evals/src/unit/tool-selection.spec.ts` — run `@vaz/evals` tier1 specs (live in `src/unit/`, not `tests/`)
- `pnpm exec biome check .` — lint check
- `pnpm exec tsc --noEmit` — type check

## Architecture

### Tech stack (VAZ)

- **Vercel AI SDK 7** (`ai`, `@ai-sdk/react`) — LLM streaming, tools, `useChat`
- **Next.js 16** App Router (Turbopack) + **React 19.2** + **React Compiler**
- **Zod v4** — runtime validation (API request bodies, env vars, tool input schemas)
- **TypeScript 6** / **Biome 2.5** (lint + format) / **Vitest 4** (unit) / **Playwright** (E2E)
- **pnpm 11.9** + **mise** (Node 24 LTS, task runner)
- **Carbon Design System** (`@carbon/react`) with per-component SCSS
- **Drizzle ORM + PostgreSQL + pgvector** — RAG persistence (`@vaz/rag`)
- **Inngest v4** — durable workflow engine (`apps/worker`)
- **Redis (node-redis)** — job event pub/sub fan-out
- **Auth.js (next-auth v5)** — JWT session, Google/Entra ID providers

### Monorepo structure

```text
apps/web/                   # Next.js app (@vaz/web)
  src/
    app/
      layout.tsx            # Root layout (imports global.scss)
      page.tsx              # Server Component; renders <Chat />
      api/chat/route.ts     # Thin HTTP⇔Agent adapter; Zod validation, stream bridging
      api/jobs/route.ts     # POST: submit supervisor plan → Inngest (202 fire-and-forget)
      api/jobs/[id]/stream/route.ts   # GET: SSE stream of JobEvents from Redis
      api/jobs/[id]/approve/route.ts  # POST: resume suspended workflow (approval decision)
    assets/styles/global.scss  # Carbon per-component @use (never import all of Carbon)
    features/chat/          # Chat.tsx + Chat.module.scss
    features/jobs/          # ApprovalPanel.tsx + useJobStream.ts
    lib/auth.ts             # Auth.js NextAuth config + toRuntimeContext()
    lib/audit.ts            # Web-path AuditSink (lazily-built, process-cached Drizzle)
    lib/jobs.ts             # findJobOwnerUserId (authorization for approve/stream routes)
  instrumentation.ts        # registerOTel + initTelemetry (runs once at server start)
apps/worker/                # @vaz/worker — Inngest durable job runner
  src/
    main.ts                 # Engine-agnostic ports: DurableEngine, runJob, createJobHandler
    inngest.ts              # Inngest-specific binding (only file that imports inngest SDK)
    start.ts                # Composition root / process entry (docker CMD)
    events.ts               # JobEventSink: DB store + Redis pub/sub
    publisher.ts            # Redis-backed JobEventPublisher
    stores.ts               # Drizzle-backed JobEventStore, AuditLogStore, JobStore
    audit.ts                # AuditSink that persists to AuditLogStore
packages/
  agents/                   # @vaz/agents — createChatAgent + createSupervisorWorkflow
  config/                   # @vaz/config — resolveModel, resolveEmbeddingModel, MODEL_ALLOWLIST, initTelemetry, role-allowlist
  db/                       # @vaz/db — Drizzle schema (RAG pgvector + workflow job/jobEvent/auditLog) + drizzle-zod contracts + migrations
  schemas/                  # @vaz/schemas — Zod schemas (chatRequestSchema, aiEnvSchema, workflows, rag, deps, auth-env)
  tools/                    # @vaz/tools — createTimeCapability, createEmailCapability (HITL demo)
  rag/                      # @vaz/rag — ingest, retrieve (pgvector queries; schema lives in @vaz/db)
  evals/                    # @vaz/evals — tier1 unit evals (src/unit/) + tier3 LLM judge (src/judge.ts)
```

### Request flows

**Chat**: `page.tsx` → `Chat.tsx` (`useChat`) → `POST /api/chat` → `createChatAgent(deps).stream(...)` → `toUIMessageStream` → `createUIMessageStreamResponse`

**Supervisor workflow**: `POST /api/jobs` → Inngest `JOB_REQUESTED_EVENT` → `apps/worker` `runJob` → `createSupervisorWorkflow(deps).dispatch(plan, { jobId })` → specialists → `JobEvent` pub/sub → `GET /api/jobs/:id/stream` SSE → `useJobStream` → `ApprovalPanel`

**Python sidecar eval**: TS caller → `POST services/agent/eval/faithfulness` or `/eval/relevancy` → `PydanticAIJudgeLLM` (Pydantic AI + LlamaIndex) → `EvalResponse`

**Python sidecar parse**: TS ingest CLI (`--via-parser`) → `POST services/agent/parse` → Docling `HybridChunker` (or LlamaParse opt-in) → `ParsedChunk[]` → back to `packages/rag` for embed+upsert

## Python sidecar (`services/agent`)

Spec `002-pydantic-enhance` (complete) added a Python sidecar alongside the TS mainline; these invariants are permanent:

- **Runtime**: FastAPI + Pydantic AI + LlamaIndex, uv-managed, pyright strict. **Stateless** — no DB, Redis, or filesystem. Exposes `POST /eval/faithfulness`, `POST /eval/relevancy`, and `POST /parse` (Docling `HybridChunker`; LlamaParse opt-in returns 501 until a future task implements the real call).
- **Boundary contract**: Pydantic is source of truth for this HTTP boundary only. OpenAPI → `openapi-typescript` → `packages/schemas/src/generated/agent-service.ts` (committed). Thin hand-written Zod wraps the generated type. Existing Zod contracts unchanged.
- **Single-writer principle**: pgvector embedding writes stay exclusively in `packages/rag` (the `--via-parser` ingest path sends files to `/parse` but embeds+upserts in TS); the Python sidecar never writes to DB.
- **Model-ID gate covers Python**: `scripts/forbid-model-ids.sh` scans `*.py` too; the sanctioned Python hardcode location is `services/agent/app/config.py` (`JUDGE_MODEL_ALLOWLIST`), carved out in the script.
- **`py:check` mise task**: `uv sync + ruff + pyright + pytest` — intentionally NOT a dependency of `mise run check` (TS gates stay green without Python toolchain). Runs in CI via the path-filtered `.github/workflows/python.yml`. Must be run from `services/agent/` (or use `mise run py:check` which sets `dir = "services/agent"`).
- **`openapi:gen` mise task**: `mise run openapi:gen` regenerates `packages/schemas/src/generated/agent-service.ts` and `openapi.snapshot.json` from the live FastAPI app's Pydantic models. Re-run whenever `services/agent/app/schemas.py` models change. Requires `uv` and `pnpm exec openapi-typescript`.

## Non-Obvious Patterns

### Monorepo packages

- **Source-only packages** — `packages/*` use `"exports": {"./*": "./src/*.ts"}` (raw TypeScript, no build step). No per-package `tsconfig.json`; type-checked transitively by consumers. Do not add standalone `tsc` to package scripts.
- **Dep graph direction** — `@vaz/schemas` and `@vaz/db` are the leaves (no runtime @vaz imports); `@vaz/config`, `@vaz/tools`, `@vaz/rag` depend on the leaves; `@vaz/agents` depends on all of those; `apps/web` and `apps/worker` depend on all. Never invert this. `@vaz/db` owns the full Drizzle schema (RAG + workflow tables) and is schema-only — the `pg` pools stay at composition roots.
- **Model IDs are locked to `@vaz/config`** — `packages/config/src/model-allowlist.ts` is the single legitimate place for hardcoded model strings (R1.8/ADR-5). A `scripts/forbid-model-ids.sh` grep gate (task `lint:model-ids`) enforces this; the only other exempted file is `@vaz/schemas/src/env.ts`. **Never hardcode model IDs anywhere else.**
- **`apps/worker` is a reusable engine-side library** — `apps/web` imports directly from `@vaz/worker/src/inngest`, `@vaz/worker/src/main`, `@vaz/worker/src/publisher`, `@vaz/worker/src/stores`, and `@vaz/worker/src/audit`. Do not create a circular dep back from `apps/worker` into `apps/web`.
- **`@vaz/evals` tier1 specs live in `src/unit/`** — not `tests/`; the root `vitest.config.ts` includes both `packages/*/tests/**` and `packages/*/src/unit/**` for this reason.

### AI SDK v7 API

- Route handlers: `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })` — both wrappers required.
- Multi-step tool use: `stopWhen: isStepCount(n)` (renamed from `stepCountIs` in v6).
- Tool definition: `tool({ inputSchema: z.object({…}), execute })` — field is `inputSchema`, not `parameters`.
- `useJobStream` uses `parseJsonEventStream` from `ai` (not `EventSource`), since it needs a `ReadableStream<Uint8Array>`.
- Full v7 docs ship in `node_modules/ai/docs/`.

### Zod v4

- `z.looseObject()` (allows unknown fields) exists in v4 not v3 — used in `chatRequestSchema` parts.
- `z.url()` and `z.email()` are built-in validators in v4 (not `z.string().email()`).
- `z.iso.datetime()` is the v4 form for ISO-8601 datetime strings (used in `jobEventSchema`).
- `z.uuid()` works standalone (e.g. `z.uuid().safeParse(jobId)`) as well as inline.

### Agent dependency injection (ADR-3)

- Agents/capabilities receive `AgentDeps` via constructor (deps-closure pattern): `db`, `logger`, `now: Clock`, optional `audit`, optional `runtimeContext`.
- `now: Clock` replaces `new Date()` everywhere — never use `new Date()` inside a tool, agent, or capability; read it from `deps.now()`.
- `AgentDeps<DB>` is generic; Phase 1 passes `db: null`. Phase 2 narrows to `AgentDeps<RagDatabase>` (a `PgDatabase<PgQueryResultHKT>`).
- Phase 1: `db: null` (stateless). Do not depend on concrete DB types in `packages/agents` or `packages/tools`; use duck-typed `isRagDatabase()` guards.

### RAG (`@vaz/rag`)

- **Embedding dimension is DDL-fixed at 768** (`EMBEDDING_DIM` in [`packages/db/src/schema.ts`](packages/db/src/schema.ts)). Changing providers with a different dimension requires a migration + full re-ingest, never a runtime change.
- **Provider mixing is forbidden** — `assertNoProviderMixing` in `packages/rag/src/ingest/index.ts` refuses to write embeddings from a different provider/model into an existing corpus; changing models always requires re-ingest.
- **`packages/schemas/src/agent-service.ts`** is the thin hand-written Zod wrapper conforming to the generated types from `packages/schemas/src/generated/agent-service.ts`. The generated file is excluded from Biome linting (`biome.json`: `"includes": ["**", "!packages/schemas/src/generated"]`).
- **Self-referencing package specifiers** — `@vaz/rag/retrieve/index` (not `../retrieve/index`) is required inside `@vaz/rag` itself because the ingest CLI runs via Node's native ESM, which cannot resolve extensionless relative imports.
- **Ingest CLI**: `pnpm --filter @vaz/rag ingest <path>` (bin script `packages/rag/bin/ingest.ts`; add `--via-parser` to route files through the sidecar's `/parse`). Corpus text files must be `.md`, `.mdx`, or `.txt`; `--via-parser` applies no extension filter (Docling decides what it can handle).
- **`@vaz/db` owns the whole Drizzle schema** — RAG tables (`document`/`chunk`/`embedding`), workflow tables (`job`/`jobEvent`/`auditLog`), `EMBEDDING_DIM`, drizzle-zod contracts, and `packages/db/drizzle/` migrations. drizzle-kit is not adopted — baseline DDL is hand-written SQL in `packages/db/drizzle/`; apply via `mise run db:migrate` (adds `_vaz_migration` tracking; fail-loud on pre-existing DB without tracking). `@vaz/db` is schema-only: `pg` pools stay at the composition roots. DB Zod contracts via `drizzle-zod`'s `createInsertSchema`/`createSelectSchema` — do not hand-write them.

### Design & process rules (002 retrospective, adopted spec 004)

- **Language-boundary contracts follow `single-source-boundary-contract-drift`**: one source of truth → committed codegen output → hand-written wrapper `satisfies` the generated type → a single drift test. Pitfall: `satisfies z.ZodType<Generated>` catches missing/mistyped fields but NOT excess fields — excess is caught by the JSON-Schema shape-comparison leg; keep both legs when adding a boundary schema.
- **Prefer existing seams; encode invariants in types**: before adding a new publish/throw/schema/vocabulary, check whether the change can join an existing single path (e.g. `--via-parser` joins the embed+upsert single-writer path; doc-gen verification reuses the closed `RunStopReason` vocabulary). Narrow input types to the minimum fields so requirements ("no conversation history") are structurally guaranteed.
- **Run an adversarial review after each phase**: a fresh-context review (grep both producer and caller sides) after reflect repeatedly caught "contract exists but unwired" defects that the phase's own Check missed. Treat it as an independent defense line, not an optional extra.
- **Task `_Boundary:_` lists must pre-include the periphery**: files a change always drags in (router registration, config extension, lockfile, the dedicated test file) belong in the task boundary up front — a "later task will touch it" note does not exempt the boundary from naming them.

### Supervisor workflow (`packages/agents/src/supervisor.ts`)

- **Engine-agnostic by design (ADR-2)** — `createSupervisorWorkflow` never imports Inngest. Durability is the `WorkflowStepRunner` seam: `{ run(stepId, fn) }`. Tests use the in-process `directStepRunner`; the Inngest worker wraps `step.run` in `apps/worker/src/inngest.ts`.
- **Three specialist kinds**: `rag-research`, `document-generation`, `data-processing`. The `data-processing` default throws `SpecialistUnavailableError` — must be overridden via `options.specialists`.
- **Citation handoff** — a `rag-research` step's `citations` are automatically threaded into a subsequent `document-generation` step that omits `citations`.
- **Approval-denied duck-typing** — `supervisor.ts` cannot import `apps/worker` (dep direction). It reads `(error as { reason?: unknown })?.reason` structurally rather than by `instanceof ApprovalDeniedError`.
- **`runtimeContext` on `buildDocumentGenerationRuntimeContext`** — exported so the shape is unit-testable; it lifts `jobId` + `"document-generation"` onto `generateText`'s `runtimeContext` for span attribution (R4.2).

### Inngest worker (`apps/worker`)

- **`apps/worker/src/inngest.ts` is the only file that imports the Inngest SDK**. All other modules operate on engine-agnostic ports.
- **Inngest v4 removed `EventSchemas.fromZod`** (the v3 typed-events helper). The client is created without compile-time event schemas; runtime validation uses `supervisorPlanSchema.parse`.
- **`step.waitForEvent` correlation** — `if: 'async.data.jobId == "${jobId}" && async.data.stepId == "${stepId}"'` — `jobId`/`stepId` are `z.uuid()` safe to interpolate.
- **`JobStore.insert` must be idempotent** — Inngest re-runs the function body on every retry and resume. `createJobStore` uses `onConflictDoNothing({ target: job.id })` for this reason.
- **Worker entry** — `apps/worker/src/start.ts`. Heavy infra deps (`pg`, `redis`, `inngest/connect`) are dynamic-imported inside `main()` so importing the module for env-parsing tests never loads them. Dockerfile CMD targets this file.

### HITL approval

- **Tool destructiveness marker** — declare `needsApproval: true` on a tool definition in `@vaz/tools`. The policy lives in `@vaz/agents`'s `createToolApprovalPolicy`, not on the tool itself.
- **Sticky taint (R5.3)** — once a RAG retrieval result is injected into the message stream, `externallyDriven` is latched `true` for the entire run (per-request scope); subsequent calls to approval-capable tools are forced to `'user-approval'` even after the delimiter scrolls out of the step's message window.
- **Recipient allow-list (R5.4)** — `RECIPIENT_ALLOWLIST` in `packages/tools/src/allowlist.ts` ships empty. Add emails there (committed, not env-driven) to permit `sendEmail` to deliver.
- **Admin role allow-list** — `ADMIN_EMAILS` in `packages/config/src/role-allowlist.ts` ships empty. Add emails there to grant the `admin` role.

### Auth (`apps/web/src/lib/auth.ts`)

- **IdP selected by `AUTH_IDP` env** — `"entra-id"` (default) or `"google-workspace"`. Auth.js auto-detects OAuth credentials (`AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`, `AUTH_GOOGLE_ID`/`_SECRET`) by naming convention; only the Entra ID issuer needs explicit passing.
- **Role is NOT read from IdP claims** — mapped from the authenticated email through `@vaz/config/role-allowlist`'s `resolveVazRole` (email → `"admin"|"member"`) because Google OIDC has no app-role claim.
- **`toRuntimeContext(session)`** returns `{ userId, role }` suitable for `AgentDeps.runtimeContext`; `null` for both when unauthenticated.

### Testing agents (TypeScript)

- Inject `MockLanguageModelV4` (from `ai/test`) via `options.model` seam on `createChatAgent` / `gradeRun` — no network required.
- Use `simulateReadableStream` from `ai` to feed chunk sequences.
- For module-state tests (e.g. `initTelemetry`): use `vi.resetModules()` + dynamic `import()` per test.
- Vitest globals (`test`, `expect`, `vi`, `describe`, `beforeEach`) need no imports (configured in `vitest.config.ts` via `globals: true`).
- `apps/web/vitest.config.ts` sets `@` alias to `./src` — use `@/features/...` in web tests.

### Testing Python sidecar (`services/agent`)

- All tests run zero-network: ASGI in-process via `httpx.ASGITransport(app=app)` (never open a real socket).
- Inject deterministic judge verdict: `app.dependency_overrides[get_judge_llm] = lambda: judge_llm_factory("YES")` — `conftest.py` autouse fixture clears overrides after every test.
- `asyncio_mode = "auto"` in `pyproject.toml` — no `@pytest.mark.asyncio` decorator needed; all `async def` test functions run automatically.
- Judge LLM faked via `pydantic_ai.models.test.TestModel(custom_output_text=...)` wrapped in `PydanticAIJudgeLLM`.
- Run single Python test: `cd services/agent && uv run pytest tests/test_eval.py::test_name -v`

### Provider

- `resolveModel()` reads env on every request — no restart needed to switch providers. Only `"anthropic"` and `"ollama"` are valid (OpenAI not supported).
- `AI_PROVIDER=ollama` needs no API key; uses `@ai-sdk/openai-compatible` pointed at `OLLAMA_BASE_URL`.
- Embedding defaults to Ollama `nomic-embed-text` (768-dim); override with `AI_EMBEDDING_PROVIDER` and `AI_EMBEDDING_MODEL`.

### Carbon styles

- Never `@use "@carbon/react"` wholesale (800 kB+ CSS). Add `@carbon/styles/scss/components/<name>` entries to [`apps/web/src/assets/styles/global.scss`](apps/web/src/assets/styles/global.scss).
- IBM Plex fonts load from Akamai CDN (`$use-akamai-cdn: true`) — Turbopack cannot resolve Carbon's webpack-only `~@ibm/plex/...` tilde paths.
- Anything importing `@carbon/react` must have `"use client"`.

### Other

- **React Compiler enabled** — do not add manual `useMemo`/`useCallback`; `reactCompiler: true` in `next.config.ts` handles it.
- **Biome excludes generated files** — `packages/schemas/src/generated/**` is excluded from Biome lint/format; do not run `biome check` on those files manually.
- **`docker compose up -d`** — required to start `db`/`redis`/`engine`/`worker` locally. Without it, RAG ingest, supervisor jobs, and approval flows won't work.
- **Type imports** — always `import type` for type-only imports (`verbatimModuleSyntax` + Biome `useImportType`).
- **Supply chain gate** — new deps with install scripts need an entry (set to `false` = audited-deny, or `true` = audited-allow) in `allowBuilds` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml). Without it, `pnpm install` errors. Versions younger than 24h don't resolve (`minimumReleaseAge: 1440`). For advisory-driven `pnpm audit` failures, follow the runbook in [`docs/dependency-policy.md`](docs/dependency-policy.md) (detection → triage → 4-tier response → verification → override/ignoreGhsas retirement tracking).
- **Three majors are deliberately held back** (re-measured 2026-09-05 during the dependency refresh; each is a decision, not a stale range):
  - **`vitest` / `@vitest/coverage-v8` stay on 4.x.** Vitest 5 flips mock state to be reset between tests by default, which empties `vi.fn().mock.calls` across `test()` boundaries. `apps/web/tests/auth.spec.ts` reads `NextAuthMock.mock.calls[0]` from a *previous* test's `await import("@/lib/auth")` (the module is cached, so `NextAuth()` is not called again), and 5 of its cases fail under 5.x. Adopting 5.x means either `clearMocks: false` in `vitest.config.ts` — opting the whole workspace out of the new isolation — or restructuring that spec to re-import per test. Neither belongs in a dependency bump; decide it on its own.
  - **`typescript` stays on 6.x.** 7.0 is the native port; adopting it is an ADR-level decision, not a range refresh.
  - **`@types/node` stays on `^24`.** The type package tracks a Node major, and `mise.toml` pins Node 24 LTS. Bump it in the same change that moves the runtime, never before.
- **Formatting** — tabs (not spaces), double quotes for JS/TS strings, 100-char line width (Biome + `.editorconfig`).
- **Git hooks checked in** — `.githooks/` (activated by `prepare` script). pre-commit: biome + tsc + vitest + audit. pre-push: Playwright E2E. Skip with `--no-verify`.
- **Telemetry** — `registerOTel` must be called before `initTelemetry` (OTel provider must exist before AI SDK bridge attaches). Both are fail-soft — never throw from `instrumentation.ts`.
- **Vitest projects** — root `vitest.config.ts` aggregates three projects: `web` (jsdom, `apps/web/tests/**`), `worker` (node, `apps/worker/tests/**`), and `packages` (node, `packages/*/tests/**` + `packages/*/src/unit/**`). Coverage (Vitest 4 semantics: only files loaded during the run are reported unless `include` adds them) measures the whole workspace — `apps/web/src/**`, `apps/worker/src/**`, `packages/*/src/**` — excluding unit-untestable entry points: App Router entries (`apps/web/src/app/**`, E2E territory), stylesheets, pure barrels, and process/CLI mains (`apps/worker/src/start.ts`, `packages/evals/src/nightly.ts`). Thresholds: lines/functions ≥ 80%.
- **`@vaz/evals` typecheck** is standalone (inline `tsc` in `package.json` scripts, not the root aggregator's `pnpm -r run typecheck`) because it has no per-package `tsconfig.json`. Run `pnpm --filter @vaz/evals run typecheck` to check it.
- **Python style** (`services/agent`): `from __future__ import annotations` on every module; ruff line-length 100, target py313; pyright strict. FastAPI `Depends()`/`Query()`/`Path()`/`Body()` in argument defaults are exempt from ruff B008 (`extend-immutable-calls` in `pyproject.toml`). Field names in Pydantic schemas are snake_case (not camelCase) — generated TS types adopt them verbatim.
- **MCP position (ADR-0001)**: MCP not currently adopted — in-process `@vaz/tools` definition used. If/when adopted: use `@ai-sdk/mcp`'s `createMCPClient()` + `client.tools()`; map `destructiveHint → needsApproval: true`; treat MCP tool results as untrusted (sticky taint R5.3). ADR at `docs/adr/0001-mcp-position.md`.
- **Privacy contract (R4.7)** — `Logger.info/warn/error` must NEVER include raw user prompts or raw tool input/output as `fields`. Log only non-sensitive identifiers (e.g. `{ messageId }`, not `{ subject, body }`). The audit log is the sanctioned place for tool arguments.
- **`JobEvent.ts` is an ISO string, not `Date`** — `JobEvent` is serialized over SSE; `AuditEntry.ts` is a `Date` (in-process only). Do not confuse the two patterns.
