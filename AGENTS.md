# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## Commands

Tasks are managed via **mise**. Always check [`mise.toml`](mise.toml) for available tasks.

| Action                  | Command                    |
| ----------------------- | -------------------------- |
| Aggregate gate (TS)     | `mise run check`           |
| Aggregate gate (Python) | `mise run py:check`        |
| Dev server (Turbopack)  | `mise run dev`             |
| Build                   | `mise run build`           |
| Unit tests (once)       | `mise run test:run`        |
| E2E tests               | `mise run test:e2e`        |
| E2E vs local Ollama     | `mise run test:e2e:ollama` |
| Lint check              | `mise run lint`            |
| Lint + format fix       | `mise run lint:fix`        |
| Type check              | `mise run typecheck`       |
| Apply DB baseline DDL   | `mise run db:migrate`      |

`mise run check` is this repo's single verification command (`lint` + `typecheck` + `test:run` + `audit` + `lint:model-ids`) — there is no task named `gate`. It deliberately excludes `py:check`, so a Python-side change needs both.

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
- **TypeScript 7** (native compiler) / **Biome 2.5** (lint + format) / **Vitest 4** (unit) / **Playwright** (E2E)
- **pnpm 12** + **mise** (Node 24 LTS, task runner)
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
- **`@vaz/agents` exports internal seams for unit-testability** — `buildChatTools`, `buildStreamTextOptions`, and `buildPrepareStep` (from `chat-agent.ts`) are exported so test code can call them directly with synthetic inputs. Do not reach into these from production callers other than `createChatAgent`.

### AI SDK v7 API

- Route handlers: `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })` — both wrappers required.
- Multi-step tool use: `stopWhen` accepts an **array for OR semantics** — `[isStepCount(MAX_STEPS), buildBudgetStopCondition(budget)]` stops at step cap OR token budget, whichever is first. The single-value form (`isStepCount(n)`) still works but misses the token-budget gate.
- Tool definition: `tool({ inputSchema: z.object({…}), execute })` — field is `inputSchema`, not `parameters`.
- `useJobStream` uses `parseJsonEventStream` from `ai` (not `EventSource`), since it needs a `ReadableStream<Uint8Array>`.
- `WindowMessages` seam on `createChatAgent` — inject `(messages) => pruneMessages({ messages, toolCalls: "before-last-3-messages" })` to compact history per step. Omitting it is byte-equivalent to prior behavior (no-op).
- Full v7 docs ship in `node_modules/ai/docs/`.

### Zod v4

- `z.looseObject()` (allows unknown fields) exists in v4 not v3 — used in `chatRequestSchema` parts.
- `z.url()` and `z.email()` are built-in validators in v4 (not `z.string().email()`).
- `z.iso.datetime()` is the v4 form for ISO-8601 datetime strings (used in `jobEventSchema`).
- `z.uuid()` works standalone (e.g. `z.uuid().safeParse(jobId)`) as well as inline.
- **`emptyToUndefined` helper** (from `@vaz/schemas/env-helpers`) is applied to every field in `parseAiEnv` so that a blank env var (`KEY=`) is treated as unset rather than an empty string that fails `min()` validation. Always wrap optional env fields this way — do not pass `env.KEY` raw to Zod schemas with `min()` or similar constraints.

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

- **Tool destructiveness marker** — declare `needsApproval: true` on a tool definition in `@vaz/tools`. The policy lives in `@vaz/agents`'s `createToolApprovalPolicy`, not on the tool itself. `sendEmail` is now registered in `buildChatTools` (wired to `createChatAgent`) making the HITL flow reachable from chat — not just unit-testable.
- **Sticky taint (R5.3)** — once a RAG retrieval result is injected into the message stream, `externallyDriven` is latched `true` for the entire run (per-request scope); subsequent calls to approval-capable tools are forced to `'user-approval'` even after the delimiter scrolls out of the step's message window.
- **Approvals must be SIGNED or the gate is decorative (R5.6)** — a `tool-approval-response` is client-supplied data, and `convertToModelMessages` rebuilds the matching `tool-approval-request` part *out of that same client message*. So the SDK's `InvalidToolApprovalError` ("no matching tool-approval-request") can never fire for a forged payload — the fake pair always agrees with itself. The only real check is the HMAC signature the SDK adds to each request and verifies on the response, and that entire path is **skipped** unless `streamText` receives a signing key. `@vaz/agents`' `buildStreamTextOptions` resolves one via `resolveApprovalSigningKey()` (in `packages/agents/src/approval-signing.ts` — `TOOL_APPROVAL_SECRET` takes priority, falls back to `AUTH_SECRET`, returns `undefined` if neither is set) and passes it as **`experimental_toolApprovalSecret`** — the SDK's spelling as of ai@7.0.97. Getting that name wrong is SILENT (`streamText` destructures known options and drops the rest; the options object is built separately so excess-property checking never sees it), which is why `packages/agents/tests/chat-agent.spec.ts` drives a forged approval end-to-end instead of asserting the option is present. When no key resolves, `createToolApprovalPolicy({ approvalsAreVerifiable: false })` returns `'denied'` instead of `'user-approval'` — fail closed, because asking a human is pointless if the answer cannot be authenticated. `playwright.config.ts` pins a test key in `webServer.env` so `hitl-approval.spec.ts` verifies the real property rather than passing because a model call failed for lack of credentials.
- **`TOOL_APPROVAL_SECRET` minimum 32 chars** — enforced by Zod schema (`z.string().min(32)`); a short key fails loudly rather than silently falling back to `AUTH_SECRET`, because a short HMAC key is brute-forceable offline from a single observed signature. `emptyToUndefined` strips blank values so `KEY=` in a dotenv file is treated as unset, not a too-short key.
- **Recipient allow-list (R5.4)** — `RECIPIENT_ALLOWLIST` in `packages/tools/src/allowlist.ts` ships empty. Add emails there (committed, not env-driven) to permit `sendEmail` to deliver. Independent of the approval gate above: while approvals were unsigned this list was the *only* thing stopping a forged approval from sending mail, which is the "neither substitutes for the other" property working as intended — not a reason to lean on it.
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
- **Unit tests cannot reach the network (X-2)** — all four Vitest projects load `tests/setup/hermetic-network.ts` as `setupFiles`, which replaces `globalThis.fetch` with a stub that rejects with `Hermetic network guard (X-2): blocked a real fetch(...)`. A mock-injection gap therefore fails loudly instead of placing a real HTTP call. Scope is `fetch` only (undici included) — `node:net`/`node:tls` are untouched because the `pg`/`redis` clients are always `vi.mock`'d. A test that legitimately exercises fetch-consuming code opts out for its own scope with `vi.stubGlobal("fetch", mockFn)` + `vi.unstubAllGlobals()` in `afterEach`; never edit the setup file to add an escape hatch. Its own proof test is `tests/repo/hermetic-network.spec.ts`.

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
- **Deliberately held-back majors** (re-measured 2026-09-12; each is a decision, not a stale range). `tests/repo/dependabot.spec.ts` couples this list to root `package.json` and `.github/dependabot.yml` — change all three together:
  - **`vitest` / `@vitest/coverage-v8` stay on 4.x.** Vitest 5 flips mock state to be reset between tests by default, which empties `vi.fn().mock.calls` across `test()` boundaries. `apps/web/tests/auth.spec.ts` reads `NextAuthMock.mock.calls[0]` from a *previous* test's `await import("@/lib/auth")` (the module is cached, so `NextAuth()` is not called again), and 5 of its cases fail under 5.x. Re-verified against vitest 5.0.0 on 2026-09-12: still exactly 5 failures in that one spec. Adopting 5.x means either `clearMocks: false` in `vitest.config.ts` — opting the whole workspace out of the new isolation — or restructuring that spec to re-import per test. Neither belongs in a dependency bump; decide it on its own.
  - **`@types/node` stays on `^24`.** The type package tracks a Node major, and `mise.toml` pins Node 24 LTS. Bump it in the same change that moves the runtime, never before.
- **TypeScript 7 is adopted at the workspace root; `packages/schemas` pins 6.0.3** (2026-09-12). TS 7 is the native compiler: `tsc --noEmit` is clean for `apps/web`, `apps/worker` and `@vaz/evals` (including its `--ignoreConfig` invocation), and `next build` type-checks through it because Next 16 defaults `experimental.useTypeScriptCli: true` and spawns `tsc` as a subprocess instead of loading the compiler API. That default is what makes TS 7 usable here at all — the 7.x `typescript` package's `main` is only `lib/version.cjs`, so `ts.createProgram`/`ts.factory`/`ts.createLanguageService` are all `undefined` (the API moved to `typescript/unstable/*`). Anything that consumes the JS compiler API breaks. In this workspace that is exactly one dependency: **`openapi-typescript`** (peer `typescript@^5.x`, builds its output as a TS AST), used by the `openapi:gen` task and imported directly by `packages/schemas/tests/contract-drift.spec.ts`. It therefore lives in `packages/schemas`' `devDependencies` alongside `typescript: "6.0.3"` and resolves 6.x from there, while the root resolves 7.x — `pnpm why typescript -r` should show exactly those two. Drop the pin (and the `openapi:gen` `--filter`) once openapi-typescript supports TS 7. Note TS 6.x has had no release since 2026-04-16, so staying on it was itself becoming the risk.
- **`.env.example` is the only env catalogue, and it has three destinations** — `apps/web/.env.local` (Next.js; its cwd is `apps/web` and it does *not* walk up, so a repo-root `.env` is invisible to it), the repo-root `.env` (read by `docker compose` for `${...}` interpolation only — 13 keys; everything else in the file is inert there), and optionally `services/agent/.env` (pydantic-settings, cwd `services/agent`). Every value in the file is **host-side**: `docker-compose.yml` writes the container-internal URLs (`postgres://…@db:5432`, `redis://redis:6379`, `http://engine:8288`) into the `worker`/`engine` service `environment` blocks directly and never interpolates them from `.env`, so `DATABASE_URL`/`REDIS_URL`/`INNGEST_BASE_URL` in a dotenv file serve host processes (`next dev`, `mise run db:migrate`, the ingest CLI) and must say `localhost`. Change `POSTGRES_USER`/`_PASSWORD`/`_DB`/`_PORT` and `DATABASE_URL` in lockstep. `tests/repo/env-example.spec.ts` enforces coverage **both ways** — every `env.X` read in non-test `apps/**`/`packages/**` needs a `KEY=` entry, and every entry needs either such a read or a line in the test's `EXTERNALLY_READ` map naming its real consumer (`@ai-sdk/anthropic`, Auth.js naming convention, the Inngest SDK, compose, pydantic-settings). This file drifted twice unnoticed before that guard existed (5→19 keys, then a missing `TOOL_APPROVAL_SECRET`). **When adding a new env key read by an SDK/compose (not by our `env.X` pattern)**, add it to the `EXTERNALLY_READ` map in `tests/repo/env-example.spec.ts` with a string naming the real consumer — do NOT just add the key to `.env.example` without also updating that map or adding a corresponding `env.KEY` read.
- **Formatting** — tabs (not spaces), double quotes for JS/TS strings, 100-char line width (Biome + `.editorconfig`).
- **Git hooks checked in** — `.githooks/` (activated by `prepare` script). pre-commit: biome + tsc + vitest + audit. pre-push: Playwright E2E. Skip with `--no-verify`.
- **CI workflows are unit-tested (X-1)** — `tests/repo/ci-workflows.spec.ts` parses every `.github/workflows/*.yml` and fails unless (a) each `uses:` reference is pinned to a **40-hex commit SHA** (never `@v4`/`@main`) and (b) each workflow declares its own `permissions:` block instead of inheriting the repo default. So adding a step with a tag-pinned action breaks `mise run test:run`, not just a lint job. Six workflows: `lint`, `tests`, `python`, `security-daily`, `eval-pr`, `eval-nightly`.
- **`security-daily.yml` is the only scheduled workflow** — it runs both dependency audits (`pnpm audit --audit-level=moderate` and the `py-audit` job = `mise run py:audit`) against an unchanged head SHA, which is how advisories that land with no commit get caught. `py:audit` is a task of its own (not inlined into `py:check`) so its `--ignore-vuln` list has exactly one home; every entry needs advisory + exclusion reason + re-evaluation deadline per [`docs/dependency-policy.md`](docs/dependency-policy.md) §3/§6.
- **Always build via `mise run build`, never bare `next build`** — the task sets `NODE_ENV=production` explicitly because a non-standard inherited `NODE_ENV` makes Next fail to prerender its own `/_global-error` page (`useContext` is null inside a `next/dist` chunk). See the NOTE in [`apps/web/src/app/global-error.tsx`](apps/web/src/app/global-error.tsx); the CI `e2e` job sets it the same way.
- **Telemetry** — `registerOTel` must be called before `initTelemetry` (OTel provider must exist before AI SDK bridge attaches). Both are fail-soft — never throw from `instrumentation.ts`.
- **Vitest projects** — root `vitest.config.ts` aggregates four projects: `web` (jsdom, `apps/web/tests/**`), `worker` (node, `apps/worker/tests/**`), `packages` (node, `packages/*/tests/**` + `packages/*/src/unit/**`), and `repo` (node, `tests/repo/**` — repo-governance guards: CI workflow hygiene (`ci-workflows.spec.ts`, X-1), dependabot/held-back-majors coupling, `.env.example` ↔ `env.*` drift, and the hermetic-network guard's own proof test (X-2)). Coverage (Vitest 4 semantics: only files loaded during the run are reported unless `include` adds them) measures the whole workspace — `apps/web/src/**`, `apps/worker/src/**`, `packages/*/src/**` — excluding unit-untestable entry points: App Router entries (`apps/web/src/app/**`, E2E territory), stylesheets, pure barrels (`packages/tools/src/index.ts`), and process/CLI mains (`apps/worker/src/start.ts`, `packages/db/bin/migrate.ts`, `packages/evals/src/nightly.ts`, `packages/evals/src/pr-gate.ts`). Thresholds: lines/functions ≥ 80%.
- **`CHAT_TOKEN_BUDGET` env var** — cumulative input+output token ceiling per chat run (default 200,000). The budget stop condition is OR'd against `isStepCount(MAX_STEPS)` in `stopWhen`; both must agree to halt. Read by `buildStreamTextOptions` from `parseAiEnv()` — not from the route.
- **`@vaz/evals` typecheck** is standalone (inline `tsc` in `package.json` scripts, not the root aggregator's `pnpm -r run typecheck`) because it has no per-package `tsconfig.json`. Run `pnpm --filter @vaz/evals run typecheck` to check it.
- **Python style** (`services/agent`): `from __future__ import annotations` on every module; ruff line-length 100, target py313; pyright strict. FastAPI `Depends()`/`Query()`/`Path()`/`Body()` in argument defaults are exempt from ruff B008 (`extend-immutable-calls` in `pyproject.toml`). Field names in Pydantic schemas are snake_case (not camelCase) — generated TS types adopt them verbatim.
- **MCP position (ADR-0001)**: MCP not currently adopted — in-process `@vaz/tools` definition used. If/when adopted: use `@ai-sdk/mcp`'s `createMCPClient()` + `client.tools()`; map `destructiveHint → needsApproval: true`; treat MCP tool results as untrusted (sticky taint R5.3). ADR at `docs/adr/0001-mcp-position.md`.
- **Privacy contract (R4.7)** — `Logger.info/warn/error` must NEVER include raw user prompts or raw tool input/output as `fields`. Log only non-sensitive identifiers (e.g. `{ messageId }`, not `{ subject, body }`). The audit log is the sanctioned place for tool arguments.
- **`JobEvent.ts` is an ISO string, not `Date`** — `JobEvent` is serialized over SSE; `AuditEntry.ts` is a `Date` (in-process only). Do not confuse the two patterns.
