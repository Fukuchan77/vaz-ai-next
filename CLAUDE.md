# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The full development guide — commands, architecture, and non-obvious patterns — lives in [AGENTS.md](AGENTS.md). Read it; the notes below only highlight what matters most and must not drift from it.

@AGENTS.md

## Most-used commands

Tasks run through **mise** (`mise.toml` is the source of truth — check it before running bare tools):

- `mise run dev` — dev server (Turbopack) on `http://localhost:3000`
- `mise run lint` / `mise run lint:fix` — Biome check / auto-fix
- `mise run typecheck` — `tsc --noEmit`
- `mise run test:run` — Vitest once; single file: `pnpm exec vitest run tests/Chat.spec.tsx`
- `mise run test:e2e` — Playwright; `mise run test:e2e:ollama` for the real chat round-trip against local Ollama

## Big-picture architecture

- **VAZ stack**: **V**ercel AI SDK 7 (`ai`, `@ai-sdk/react`) + Next.js 16 App Router (Turbopack) + **Z**od v4. React 19.2 with React Compiler; Carbon Design System for UI.
- **Request flow**: `src/app/page.tsx` (Server Component) → `src/features/chat/Chat.tsx` (`"use client"`, `useChat`) → `POST src/app/api/chat/route.ts`. The route validates the body with `chatRequestSchema`, then `streamText({ model: resolveModel(), tools, stopWhen: isStepCount(5) })` and returns a UI message stream.
- **Provider resolution is per-request**: `src/lib/ai/provider.ts#resolveModel()` reads env vars (validated by `src/lib/ai/env.ts`) on every request — switch between Anthropic (`claude-opus-4-8`, needs `ANTHROPIC_API_KEY`) and Ollama (no key) via env only, no restart.
- **Feature-based colocation**: components + scoped `*.module.scss` live together under `src/features/*`. Anything importing `@carbon/react` must be a client component.

## Things that bite

- **AI SDK v7 API surface** — `createUIMessageStreamResponse` + `toUIMessageStream`; `stopWhen: isStepCount(n)` (was `stepCountIs` in v6). Full v7 docs ship in `node_modules/ai/docs/`.
- **Carbon styles** — never `@use "@carbon/react"` wholesale; add per-component entries to `src/assets/styles/global.scss`. Carbon usage requires `"use client"`.
- **Git hooks are checked in** (`.githooks/`, activated by the `prepare` script): pre-commit runs biome + tsc + vitest + audit; pre-push runs Playwright E2E.
- **New deps with install scripts** must be recorded in `allowBuilds` in `pnpm-workspace.yaml` and set to `true` to run (entries default to `false` = denied; presence alone is just an audited decision). Versions younger than 24h won't resolve (`minimumReleaseAge`).
- Use `import type` (enforced by Biome + `verbatimModuleSyntax`). Vitest globals (`test`/`expect`/`vi`) need no imports.
