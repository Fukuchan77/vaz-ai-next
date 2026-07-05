# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full development guide — commands, architecture, and non-obvious patterns — lives in [AGENTS.md](AGENTS.md). Read it; the notes below only highlight what matters most and must not drift from it.

@AGENTS.md

## Most-used commands

Tasks run through **mise** (`mise.toml` is the source of truth — check it before running bare tools):

- `mise run dev` — dev server (Turbopack) on `http://localhost:3000`
- `mise run lint` / `mise run lint:fix` — Biome check / auto-fix
- `mise run typecheck` — `tsc --noEmit`
- `mise run test:run` — Vitest once; single package file: `pnpm exec vitest run --project packages packages/agents/tests/chat-agent.spec.ts`
- `mise run test:e2e` — Playwright; `mise run test:e2e:ollama` for the real chat round-trip against local Ollama

## Big-picture architecture

- **VAZ stack**: **V**ercel AI SDK 7 (`ai`, `@ai-sdk/react`) + Next.js 16 App Router (Turbopack) + **Z**od v4. React 19.2 with React Compiler; Carbon Design System for UI.
- **Monorepo**: one app `apps/web` (`@vaz/web`) over four source-only `@vaz/*` packages. One-way dep graph: `schemas` (leaf) → `config`/`tools` → `agents` → `web`. Packages ship raw TS (no build step, no per-package `tsconfig`); import by path (`@vaz/schemas/deps`). During Phase 1 (spec `001-vaz-ai-update`) a duplicate root `src/`/`tests/` still exists mid-migration — treat `apps/web` as the source of truth.
- **Request flow**: `apps/web/src/app/page.tsx` (Server Component) → `src/features/chat/Chat.tsx` (`"use client"`, `useChat`) → `POST src/app/api/chat/route.ts`. The route is a thin HTTP⇔Agent adapter: validate with `chatRequestSchema`, build `AgentDeps`, then `createChatAgent(deps).stream(...)` and bridge via `toUIMessageStream` → `createUIMessageStreamResponse`. Orchestration (`streamText`, tools, `stopWhen: isStepCount(5)`) lives in `@vaz/agents`, **not** the route.
- **Provider resolution is per-request**: `@vaz/config#resolveModel()` reads env (validated by `@vaz/schemas/env`) on every request — switch Anthropic (`claude-opus-4-8`, needs `ANTHROPIC_API_KEY`) ↔ Ollama (no key) via env only, no restart.
- **Feature-based colocation**: components + scoped `*.module.scss` live together under `apps/web/src/features/*`. Anything importing `@carbon/react` must be a client component.

## Things that bite

- **Dependency injection (ADR-3)** — agents/capabilities take `AgentDeps` (`db`, `logger`, `now: Clock`, optional `audit`) by constructor. Never `new Date()` inside a tool or agent — read `deps.now()` so time is pinnable in tests.
- **Model IDs live only in `@vaz/config`** (`model-allowlist.ts`) and, as Zod defaults, `@vaz/schemas/src/env.ts` (R1.8/ADR-5). Anywhere else, a grep gate (`lint:model-ids`) fails the build. Never hardcode a model string elsewhere.
- **AI SDK v7 API surface** — `createUIMessageStreamResponse` + `toUIMessageStream`; `stopWhen: isStepCount(n)` (was `stepCountIs` in v6); tool field is `inputSchema` (not `parameters`). Full v7 docs ship in `node_modules/ai/docs/`.
- **Test agents without a network** — inject `MockLanguageModelV4` (`ai/test`) via the `model` seam on `createChatAgent`; `simulateReadableStream` feeds chunks. Vitest projects: `web` (jsdom), `packages` (node), `root-legacy` (transitional).
- **Telemetry is fail-soft** — `instrumentation.ts` calls `registerOTel` *then* `initTelemetry` (provider before AI SDK bridge); neither throws.
- **Carbon styles** — never `@use "@carbon/react"` wholesale; add per-component entries to `apps/web/src/assets/styles/global.scss`. Carbon usage requires `"use client"`.
- **Git hooks are checked in** (`.githooks/`, activated by the `prepare` script): pre-commit runs biome + tsc + vitest + audit; pre-push runs Playwright E2E.
- **New deps with install scripts** must be recorded in `allowBuilds` in `pnpm-workspace.yaml` and set to `true` to run (entries default to `false` = denied; presence alone is just an audited decision). Versions younger than 24h won't resolve (`minimumReleaseAge`).
- Use `import type` (enforced by Biome + `verbatimModuleSyntax`). Vitest globals (`test`/`expect`/`vi`) need no imports.
