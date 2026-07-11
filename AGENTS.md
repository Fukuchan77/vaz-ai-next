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
- `pnpm exec vitest run tests/Chat.spec.tsx` — run a single root-legacy test file
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
  schemas/                  # @vaz/schemas — Zod schemas (chatRequestSchema, aiEnvSchema, workflows, rag, deps, auth-env)
  tools/                    # @vaz/tools — createTimeCapability, createEmailCapability (HITL demo)
  rag/                      # @vaz/rag — ingest, retrieve, Drizzle schema (pgvector)
  evals/                    # @vaz/evals — tier1 unit evals (src/unit/) + tier3 LLM judge (src/judge.ts)
tests/                      # root-legacy Vitest specs (transitional; migrating to apps/web/tests/)
```

### Request flows

**Chat**: `page.tsx` → `Chat.tsx` (`useChat`) → `POST /api/chat` → `createChatAgent(deps).stream(...)` → `toUIMessageStream` → `createUIMessageStreamResponse`

**Supervisor workflow**: `POST /api/jobs` → Inngest `JOB_REQUESTED_EVENT` → `apps/worker` `runJob` → `createSupervisorWorkflow(deps).dispatch(plan, { jobId })` → specialists → `JobEvent` pub/sub → `GET /api/jobs/:id/stream` SSE → `useJobStream` → `ApprovalPanel`

## Non-Obvious Patterns

### Monorepo packages

- **Source-only packages** — `packages/*` use `"exports": {"./*": "./src/*.ts"}` (raw TypeScript, no build step). No per-package `tsconfig.json`; type-checked transitively by consumers. Do not add standalone `tsc` to package scripts.
- **Dep graph direction** — `@vaz/schemas` is the leaf (no @vaz imports); `@vaz/config`, `@vaz/tools`, `@vaz/rag` depend on `@vaz/schemas`; `@vaz/agents` depends on all four; `apps/web` and `apps/worker` depend on all. Never invert this.
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

- **Embedding dimension is DDL-fixed at 768** (`EMBEDDING_DIM` in `packages/rag/src/db/schema.ts`). Changing providers with a different dimension requires a migration + full re-ingest, never a runtime change.
- **Provider mixing is forbidden** — `assertNoProviderMixing` in `packages/rag/src/ingest/index.ts` refuses to write embeddings from a different provider/model into an existing corpus; changing models always requires re-ingest.
- **Self-referencing package specifiers** — `@vaz/rag/db/schema` (not `../db/schema`) is required inside `@vaz/rag` itself because the ingest CLI runs via Node's native ESM, which cannot resolve extensionless relative imports.
- **Ingest CLI**: run via `node packages/rag/src/ingest/index.ts` (no bin script yet). Corpus text files must be `.md`, `.mdx`, or `.txt`.
- **DB Zod contracts**: generated by `drizzle-zod`'s `createInsertSchema`/`createSelectSchema` — single-sourced from the Drizzle table definitions; do not hand-write them.
- **`@vaz/rag` is also the home of Phase 3 DB schema** (`job`, `jobEvent`, `auditLog`) because it owns the Drizzle+pg setup; a dedicated `@vaz/db` split is a future refactor.

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

### Testing agents

- Inject `MockLanguageModelV4` (from `ai/test`) via `options.model` seam on `createChatAgent` / `gradeRun` — no network required.
- Use `simulateReadableStream` from `ai` to feed chunk sequences.
- For module-state tests (e.g. `initTelemetry`): use `vi.resetModules()` + dynamic `import()` per test.
- Vitest globals (`test`, `expect`, `vi`, `describe`, `beforeEach`) need no imports (configured in `vitest.config.ts` via `globals: true`).

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
- **Type imports** — always `import type` for type-only imports (`verbatimModuleSyntax` + Biome `useImportType`).
- **Supply chain gate** — new deps with install scripts need an entry (set to `false` = audited-deny, or `true` = audited-allow) in `allowBuilds` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml). Without it, `pnpm install` errors. Versions younger than 24h don't resolve (`minimumReleaseAge: 1440`).
- **Formatting** — tabs (not spaces), double quotes for JS/TS strings, 100-char line width (Biome + `.editorconfig`).
- **Git hooks checked in** — `.githooks/` (activated by `prepare` script). pre-commit: biome + tsc + vitest + audit. pre-push: Playwright E2E. Skip with `--no-verify`.
- **Telemetry** — `registerOTel` must be called before `initTelemetry` (OTel provider must exist before AI SDK bridge attaches). Both are fail-soft — never throw from `instrumentation.ts`.
- **Vitest projects** — root `vitest.config.ts` aggregates four projects: `web` (jsdom, `apps/web/tests/**`), `worker` (node, `apps/worker/tests/**`), `packages` (node, `packages/*/tests/**` + `packages/*/src/unit/**`), `root-legacy` (jsdom, transitional root `tests/**`). Coverage only targets root `src/`, excluding `src/app/**` (App Router = E2E territory).
- **`@vaz/evals` typecheck** is standalone (inline `tsc` in `package.json` scripts, not the root aggregator's `pnpm -r run typecheck`) because it has no per-package `tsconfig.json`. Run `pnpm --filter @vaz/evals run typecheck` to check it.
- **Privacy contract (R4.7)** — `Logger.info/warn/error` must NEVER include raw user prompts or raw tool input/output as `fields`. Log only non-sensitive identifiers (e.g. `{ messageId }`, not `{ subject, body }`). The audit log is the sanctioned place for tool arguments.
- **`JobEvent.ts` is an ISO string, not `Date`** — `JobEvent` is serialized over SSE; `AuditEntry.ts` is a `Date` (in-process only). Do not confuse the two patterns.
