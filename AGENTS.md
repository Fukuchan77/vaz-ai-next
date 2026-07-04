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

Direct pnpm equivalents (when mise is unavailable):

- `pnpm exec vitest run` — run unit tests once
- `pnpm exec vitest run tests/Chat.spec.tsx` — run a single test file
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

### Directory structure

```text
src/
  app/
    layout.tsx                # Root layout (imports global.scss)
    page.tsx                  # Server Component; renders <Chat />
    api/chat/route.ts         # POST: Zod-validated, streamText + tools, UI message stream
  assets/styles/global.scss   # Carbon per-component @use (never import all of Carbon)
  features/chat/              # Feature-based colocation (component + scoped scss)
  lib/ai/
    env.ts                    # Zod schema for AI_PROVIDER / model env vars
    provider.ts               # resolveModel(): Anthropic or Ollama (OpenAI-compatible)
    chat-schema.ts            # Zod schema for /api/chat request body
tests/                        # Vitest unit tests (jsdom, globals)
tests/e2e/                    # Playwright specs (chat-ollama.spec.ts auto-skips without Ollama)
```

## Non-Obvious Patterns

- **AI SDK v7 API** — route handlers use `streamText` → `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })`; multi-step tool use via `stopWhen: isStepCount(n)` (renamed from `stepCountIs` in v6). Full v7 docs ship inside the package: `node_modules/ai/docs/`.
- **Zod v4 tool schemas** — tools use `inputSchema:` (not `parameters:`), and `z.looseObject()` is available in v4 (not v3).
- **Provider switch is per-request** — `resolveModel()` reads env vars on every request; no server restart needed to change models. `AI_PROVIDER=ollama` needs no API key; only `["anthropic", "ollama"]` are valid (OpenAI is not supported).
- **Model IDs** — Anthropic default is `claude-opus-4-8` (exact string, no date suffix). Ollama default is `llama3.2`.
- **Carbon styles** — never `@use "@carbon/react"` wholesale (800 kB+ CSS). Add `@carbon/styles/scss/components/*` entries to `global.scss` per component used. IBM Plex fonts load from the Akamai CDN (`$use-akamai-cdn: true`) because Turbopack cannot resolve Carbon's webpack-style `~@ibm/plex/...` font URLs.
- **Carbon components are client-only** — anything importing `@carbon/react` needs `"use client"`; keep `src/app/page.tsx` a Server Component and put Carbon usage in `src/features/*`.
- **React Compiler enabled** — manual `useMemo`/`useCallback` are unnecessary; `reactCompiler: true` in `next.config.ts` handles auto-memoization.
- **Sass deprecation silencing** — `next.config.ts` silences `color-functions`, `global-builtin`, and `import` deprecations because Carbon v1.x is not yet compatible with the Sass modern API.
- **Vitest globals enabled** — test files use `test`, `expect`, `vi` without imports (types via `tests/tsconfig.json`). `@testing-library/jest-dom/vitest` matchers loaded via `tests/setupTests.ts`.
- **Vitest is independent of Next** — `vitest.config.ts` uses `@vitejs/plugin-react` and an `@ → src` alias; it does not load `next.config.ts`. `src/app/**` is excluded from coverage thresholds (App Router entries are validated by E2E only).
- **E2E Playwright** — uses `pnpm dev` locally (reuses existing server) and `pnpm start` on CI (requires a prior `pnpm build`). The Ollama spec self-skips when `AI_PROVIDER !== "ollama"` or Ollama is unreachable.
- **Git hooks are checked in** — `.githooks/` activated by the `prepare` script (`core.hooksPath`). pre-commit: biome + tsc + vitest + `pnpm audit --audit-level=moderate`. pre-push: Playwright E2E (auto-detects Ollama via `curl` and switches `AI_PROVIDER=ollama`). Skip with `--no-verify`.
- **Type imports** — use `import type` (enforced by Biome `useImportType` and `verbatimModuleSyntax`).
- **Supply chain** — new deps with install scripts must be recorded in `allowBuilds` in `pnpm-workspace.yaml` (default deny). Versions younger than 24h don't resolve (`minimumReleaseAge: 1440`).
- **Formatting** — tabs (not spaces), double quotes for JS/TS strings, 100-char line width (enforced by Biome + `.editorconfig`).
