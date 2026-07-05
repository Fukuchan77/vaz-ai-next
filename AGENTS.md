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

- `pnpm exec vitest run` — run all unit tests once
- `pnpm exec vitest run tests/Chat.spec.tsx` — run a single root-legacy test file
- `pnpm exec vitest run --project packages packages/agents/tests/chat-agent.spec.ts` — run a single package test
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

### Monorepo structure

```text
apps/web/                   # Next.js app (@vaz/web)
  src/
    app/
      layout.tsx            # Root layout (imports global.scss)
      page.tsx              # Server Component; renders <Chat />
      api/chat/route.ts     # Thin HTTP⇔Agent adapter; Zod validation, stream bridging
    assets/styles/global.scss  # Carbon per-component @use (never import all of Carbon)
    features/chat/          # Component + scoped Chat.module.scss
  instrumentation.ts        # registerOTel + initTelemetry (runs once at server start)
packages/
  agents/                   # @vaz/agents — createChatAgent (orchestration)
  config/                   # @vaz/config — resolveModel, MODEL_ALLOWLIST, initTelemetry
  schemas/                  # @vaz/schemas — Zod schemas (chatRequestSchema, aiEnvSchema), AgentDeps types
  tools/                    # @vaz/tools — createTimeCapability (deps-closure clock injection)
tests/                      # root-legacy Vitest specs (transitional; migrating to apps/web/tests/)
```

### Request flow

`page.tsx` (Server) → `Chat.tsx` (`"use client"`, `useChat`) → `POST /api/chat` (route validates with `chatRequestSchema`, constructs `AgentDeps`, calls `createChatAgent(deps).stream(...)`) → `toUIMessageStream` → `createUIMessageStreamResponse`

## Non-Obvious Patterns

### Monorepo packages

- **Source-only packages** — `packages/*` use `"exports": {"./*": "./src/*.ts"}` (raw TypeScript, no build step). No per-package `tsconfig.json`; type-checked transitively by consumers. Do not add standalone `tsc` to package scripts.
- **Dep graph direction** — `@vaz/schemas` is the leaf (no @vaz imports); `@vaz/config` and `@vaz/tools` depend on `@vaz/schemas`; `@vaz/agents` depends on all three; `apps/web` depends on all.
- **Model IDs are locked to `@vaz/config`** — `packages/config/src/model-allowlist.ts` is the single legitimate place for hardcoded model strings (R1.8/ADR-5). A `scripts/forbid-model-ids.sh` grep gate (task `lint:model-ids`) enforces this; the only other exempted file is `@vaz/schemas/src/env.ts` (leaf, can't import config). **Never hardcode model IDs anywhere else.**

### AI SDK v7 API

- Route handlers: `createUIMessageStreamResponse({ stream: toUIMessageStream({ stream: result.stream }) })` — both wrappers required.
- Multi-step tool use: `stopWhen: isStepCount(n)` (renamed from `stepCountIs` in v6).
- Tool definition: `tool({ inputSchema: z.object({…}), execute })` — field is `inputSchema`, not `parameters`.
- Full v7 docs ship in `node_modules/ai/docs/`.

### Zod v4

- `z.looseObject()` (allows unknown fields) exists in v4 not v3 — used in `chatRequestSchema` parts.
- `z.url()` is a built-in validator in v4.

### Agent dependency injection (ADR-3)

- Agents/capabilities receive `AgentDeps` via constructor (deps-closure pattern): `db`, `logger`, `now: Clock`, optional `audit`.
- `now: Clock` replaces `new Date()` everywhere — never use `new Date()` inside a tool or agent; read it from `deps.now()`.
- Phase 1: `db: null` (stateless). Later phases narrow the `DB` generic.

### Testing agents

- Inject `MockLanguageModelV4` (from `ai/test`) via `options.model` seam on `createChatAgent` — no network required.
- Use `simulateReadableStream` from `ai` to feed chunk sequences.
- For module-state tests (e.g. `initTelemetry`): use `vi.resetModules()` + dynamic `import()` per test.
- Vitest globals (`test`, `expect`, `vi`, `describe`, `beforeEach`) need no imports (configured in `vitest.config.ts` via `globals: true`).

### Provider

- `resolveModel()` reads env on every request — no restart needed to switch providers. Only `"anthropic"` and `"ollama"` are valid (OpenAI not supported).
- `AI_PROVIDER=ollama` needs no API key; uses `@ai-sdk/openai-compatible` pointed at `OLLAMA_BASE_URL`.

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
- **Vitest projects** — root `vitest.config.ts` aggregates three projects: `web` (jsdom, `apps/web`), `packages` (node, `packages/*/tests/**`), `root-legacy` (jsdom, transitional root `tests/**`). Coverage only targets root `src/`, excluding `src/app/**` (App Router = E2E territory).
