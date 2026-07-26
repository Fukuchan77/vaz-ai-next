# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full development guide — commands, architecture, and non-obvious patterns — lives in [AGENTS.md](AGENTS.md). Read it; the notes below only highlight what matters most and must not drift from it.

Governance docs: [`docs/agentops.md`](docs/agentops.md) maps this repo's observability/evaluation/optimization implementation to the AgentOps three pillars; [`docs/adr/0001-mcp-position.md`](docs/adr/0001-mcp-position.md) records the MCP adoption decision and its trigger conditions.

@AGENTS.md

## Most-used commands

Tasks run through **mise** (`mise.toml` is the source of truth — check it before running bare tools):

- `mise run dev` — dev server (Turbopack) on `http://localhost:3000`
- `mise run lint` / `mise run lint:fix` — Biome check / auto-fix
- `mise run typecheck` — `tsc --noEmit`
- `mise run test:run` — Vitest once; single package file: `pnpm exec vitest run --project packages packages/agents/tests/chat-agent.spec.ts`
- `mise run test:e2e` — Playwright; `mise run test:e2e:ollama` for the real chat round-trip against local Ollama
- `docker compose up -d` — local `db`/`redis`/`engine`/`worker` stack, needed for RAG ingest or job/approval work

## Big-picture architecture

- **VAZ stack**: **V**ercel AI SDK 7 (`ai`, `@ai-sdk/react`) + Next.js 16 App Router (Turbopack) + **Z**od v4. React 19.2 with React Compiler; Carbon Design System for UI.
- **Monorepo**: two apps (`apps/web` = `@vaz/web`, `apps/worker` = `@vaz/worker`) over six source-only `@vaz/*` packages (`schemas`, `config`, `tools`, `rag`, `agents`, `evals`). One-way dep graph: `schemas` (leaf) → `config`/`tools`/`rag` → `agents` → `web`/`worker`/`evals`. Packages ship raw TS (no build step, no per-package `tsconfig`); import by path (`@vaz/schemas/deps`). The legacy root `src/`/`tests/` migration (spec `001-vaz-ai-update`) is complete — `apps/web` is the sole source of truth; no application source lives at the repo root.
- **Chat request flow**: `apps/web/src/app/page.tsx` (Server Component) → `features/chat/Chat.tsx` (`"use client"`, `useChat`) → `POST api/chat/route.ts`. The route is a thin HTTP⇔Agent adapter: validate with `chatRequestSchema`, build `AgentDeps` (incl. `runtimeContext` from the OIDC session), then `createChatAgent(deps).stream(...)` and bridge via `toUIMessageStream` → `createUIMessageStreamResponse`. Orchestration (`streamText`, tools, `stopWhen: isStepCount(5)`, RAG retrieval tool) lives in `@vaz/agents`, **not** the route.
- **Durable job flow**: `POST api/jobs` submits a supervisor plan as an Inngest event; `apps/worker` runs `createSupervisorWorkflow(deps).dispatch(...)`, dispatching to specialists (`rag-research`/`document-generation`/`data-processing`); progress fans out over Redis to `GET api/jobs/:id/stream` (SSE) → `useJobStream` → `ApprovalPanel`. Destructive tool calls (`needsApproval: true`) suspend for human approve/reject/edit via `POST api/jobs/:id/approve`, and resume correctly across worker restarts (Inngest owns durability; AI SDK owns the typed approval contract — ADR-2).
- **Provider resolution is per-request**: `@vaz/config#resolveModel()` / `resolveEmbeddingModel()` read env (validated by `@vaz/schemas/env`) on every request — switch Anthropic (`claude-opus-4-8`, needs `ANTHROPIC_API_KEY`) ↔ Ollama (no key) via env only, no restart.
- **Auth + RBAC**: OIDC via Auth.js (Entra ID / Google Workspace, chosen by `AUTH_IDP`). Role is never read from an IdP claim — `apps/web/src/lib/auth.ts` resolves it from the authenticated email through `@vaz/config`'s committed `ADMIN_EMAILS` allowlist, then carries `{ userId, role }` as `AgentDeps.runtimeContext`.
- **Feature-based colocation**: components + scoped `*.module.scss` live together under `apps/web/src/features/*` (`chat/`, `jobs/`). Anything importing `@carbon/react` must be a client component.

## Things that bite

- **Dependency injection (ADR-3)** — agents/capabilities take `AgentDeps<DB>` (`db`, `logger`, `now: Clock`, optional `audit`, optional `runtimeContext`) by constructor. Never `new Date()` inside a tool or agent — read `deps.now()` so time is pinnable in tests.
- **Model IDs live only in `@vaz/config`** (`model-allowlist.ts`) and, as Zod defaults, `@vaz/schemas/src/env.ts` (R1.8/ADR-5). Anywhere else, a grep gate (`lint:model-ids`) fails the build. Never hardcode a model string elsewhere.
- **AI SDK v7 API surface** — `createUIMessageStreamResponse` + `toUIMessageStream`; `stopWhen: isStepCount(n)` (was `stepCountIs` in v6); tool field is `inputSchema` (not `parameters`). Full v7 docs ship in `node_modules/ai/docs/`.
- **Two independent controls on destructive tools** — HITL approval (`needsApproval`, policy in `@vaz/agents`) and a committed recipient allow-list (`RECIPIENT_ALLOWLIST` in `packages/tools/src/allowlist.ts`) are separate gates; neither substitutes for the other. Both allow-lists (`ADMIN_EMAILS`, `RECIPIENT_ALLOWLIST`) ship empty — add entries as reviewed, committed code changes, never via env.
- **Prompt-injection defense** — RAG results are wrapped as explicitly delimited context blocks (`packages/agents/src/prompt.ts`); once injected, `externallyDriven` is sticky for the rest of the run and forces approval-capable tools into `'user-approval'` even after the delimiter scrolls out of context.
- **Tool-execution audit log has one firing point** — `@vaz/agents`'s lifecycle hook (`audit-hook.ts`) records every tool call for both web and worker paths; persistence is injected via `deps.audit` (`apps/web/src/lib/audit.ts`, `apps/worker/src/audit.ts`). Never log raw prompts or raw tool args/output outside the audit sink (R4.7 privacy contract).
- **RAG embedding dimension is DDL-fixed** (768, Ollama `nomic-embed-text` default) — changing embedding provider/model requires a migration + full re-ingest; `assertNoProviderMixing` refuses to mix provenance in one corpus.
- **`apps/worker` is engine-agnostic except one file** — only `apps/worker/src/inngest.ts` imports the Inngest SDK; everything else operates on ports (`DurableEngine`, `JobEventSink`, `AuditSink`) so the engine could be swapped.
- **Test agents without a network** — inject `MockLanguageModelV4` (`ai/test`) via the `model` seam on `createChatAgent`; `simulateReadableStream` feeds chunks. Vitest projects: `web` (jsdom), `worker` (node), `packages` (node, incl. `@vaz/evals`'s `src/unit/**`).
- **Telemetry is fail-soft** — `instrumentation.ts` calls `registerOTel` *then* `initTelemetry` (provider before AI SDK bridge); neither throws.
- **Carbon styles** — never `@use "@carbon/react"` wholesale; add per-component entries to `apps/web/src/assets/styles/global.scss`. Carbon usage requires `"use client"`.
- **Git hooks are checked in** (`.githooks/`, activated by the `prepare` script): pre-commit runs biome + tsc + vitest + audit; pre-push runs Playwright E2E.
- **New deps with install scripts** must be recorded in `allowBuilds` in `pnpm-workspace.yaml` and set to `true` to run (entries default to `false` = denied; presence alone is just an audited decision). Versions younger than 24h won't resolve (`minimumReleaseAge`).
- Use `import type` (enforced by Biome + `verbatimModuleSyntax`). Vitest globals (`test`/`expect`/`vi`) need no imports.
