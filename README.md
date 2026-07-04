<h1 align="center">VAZ-AI-Next</h1>

<p align="center">
  A bleeding-edge AI application repository architecture, blending modern frontend performance with seamless AI orchestration.
</p>

---

## English

At its core (**VAZ**), the project harmonizes **V**ercel AI SDK for robust LLM streaming, Next.js 16 **A**pp Router for unified server/client architecture, and **Z**od v4 for rigorous runtime type validation.

By eliminating boilerplate optimization via the React Compiler and leveraging a lightning-fast, Rust-powered toolchain (Turbopack, Biome, and Vitest), this repository achieves the absolute pinnacle of developer experience and production execution speed.

### Tech Stack

| Area                    | Technology                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| AI toolkit              | [Vercel AI SDK 7](https://ai-sdk.dev) (`ai` + `@ai-sdk/react`)                                                                                 |
| LLM providers           | [Anthropic Claude](https://www.anthropic.com) (`@ai-sdk/anthropic`) / local LLM via [Ollama](https://ollama.com) (`@ai-sdk/openai-compatible`) |
| Framework               | [Next.js 16](https://nextjs.org) App Router (Turbopack)                                                                                        |
| Compiler                | [React Compiler](https://react.dev/learn/react-compiler) (automatic memoization)                                                               |
| Runtime validation      | [Zod v4](https://zod.dev)                                                                                                                      |
| Language                | [TypeScript 6](https://www.typescriptlang.org)                                                                                                 |
| Lint / Format           | [Biome 2.5+](https://biomejs.dev)                                                                                                              |
| Unit testing            | [Vitest 4](https://vitest.dev) + [Testing Library](https://testing-library.com)                                                                |
| E2E testing             | [Playwright](https://playwright.dev) (Chromium / Firefox)                                                                                      |
| UI components           | [Carbon Design System](https://carbondesignsystem.com) (`@carbon/react`, per-component SCSS)                                                   |
| Package manager         | [pnpm 11.9+](https://pnpm.io)                                                                                                                  |
| Task runner / toolchain | [mise](https://mise.jdx.dev) (Node 24 LTS + pnpm pinned)                                                                                       |

### Getting Started

Prerequisite: [mise](https://mise.jdx.dev) installed (it provides Node 24 LTS and pnpm 11.9 pinned in `mise.toml`).

```bash
mise install        # Node 24 / pnpm 11.9.0
pnpm install        # install dependencies (also activates git hooks)
cp .env.example .env.local
mise run dev        # http://localhost:3000
```

### Choosing an AI provider

The chat API resolves its language model at request time from environment variables (validated with Zod — see `src/lib/ai/env.ts`):

| Variable            | Default                     | Description                           |
| ------------------- | --------------------------- | ------------------------------------- |
| `AI_PROVIDER`       | `anthropic`                 | `anthropic` or `ollama`               |
| `ANTHROPIC_API_KEY` | —                           | Required when `AI_PROVIDER=anthropic` |
| `ANTHROPIC_MODEL`   | `claude-opus-4-8`           | Claude model ID                       |
| `OLLAMA_BASE_URL`   | `http://localhost:11434/v1` | Ollama's OpenAI-compatible endpoint   |
| `OLLAMA_MODEL`      | `llama3.2`                  | Any model pulled into Ollama          |

Local LLM (no API key needed):

```bash
ollama pull llama3.2
AI_PROVIDER=ollama pnpm dev
```

### Tasks

Tasks are managed with **mise** (`mise.toml` is the source of truth); direct `pnpm` equivalents also work.

| Purpose                | mise                       | pnpm                               |
| ---------------------- | -------------------------- | ---------------------------------- |
| Dev server (Turbopack) | `mise run dev`             | `pnpm dev`                         |
| Production build       | `mise run build`           | `pnpm build`                       |
| Serve production build | `mise run start`           | `pnpm start`                       |
| Unit tests (watch)     | `mise run test`            | `pnpm test`                        |
| Unit tests (once)      | `mise run test:run`        | `pnpm test:run`                    |
| Coverage               | `mise run test:coverage`   | `pnpm exec vitest run --coverage`  |
| E2E tests              | `mise run test:e2e`        | `pnpm test:e2e`                    |
| E2E vs local Ollama    | `mise run test:e2e:ollama` | `AI_PROVIDER=ollama pnpm test:e2e` |
| Lint / format check    | `mise run lint`            | `pnpm lint`                        |
| Lint / format fix      | `mise run lint:fix`        | `pnpm lint:fix`                    |
| Type check             | `mise run typecheck`       | `pnpm typecheck`                   |

### Project Structure

Feature-based colocation: components, hooks, and scoped styles live together per domain.

```text
src/
  app/
    layout.tsx                # Root layout (global styles, metadata)
    page.tsx                  # Home page (Server Component)
    api/chat/route.ts         # Streaming chat endpoint (Zod-validated, streamText + tools)
  assets/styles/global.scss   # Carbon styles (per-component @use only)
  features/chat/
    Chat.tsx                  # Chat UI (useChat, message parts rendering)
    Chat.module.scss          # Scoped styles
  lib/ai/
    env.ts                    # Zod schema for AI environment variables
    provider.ts               # Provider switch (Anthropic / Ollama)
    chat-schema.ts            # Zod schema for /api/chat request bodies
tests/
  *.spec.{ts,tsx}             # Vitest unit tests
  e2e/                        # Playwright E2E tests (incl. Ollama round-trip)
```

### Git Hooks (quality gates)

`pnpm install` activates the checked-in hooks in `.githooks/` (via `core.hooksPath`):

- **pre-commit** — `biome check` → `tsc --noEmit` → `vitest run` → `pnpm audit`
- **pre-push** — Playwright E2E; if a local Ollama is detected, it automatically runs with `AI_PROVIDER=ollama`, including a real chat round-trip against the local LLM

Bypass in an emergency with `--no-verify`.

### Supply-Chain Hardening

Configured in `pnpm-workspace.yaml`:

- `minimumReleaseAge: 1440` — never resolve versions published less than 24h ago (mitigates freshly-published malicious releases)
- `allowBuilds` — dependency install scripts are blocked by default; every decision is recorded explicitly (all currently `false`)
- pnpm itself is version-pinned via `mise.toml`
- CI runs `pnpm install --frozen-lockfile` + `pnpm audit --audit-level=moderate`

### CI

Every push runs GitHub Actions:

- **lint** — `biome check` + `tsc --noEmit`
- **tests** — `vitest run --coverage` (unit) / Playwright (E2E, official container image) / `pnpm audit`

### For AI Coding Agents

Repository-specific conventions live in [`AGENTS.md`](AGENTS.md).

---

## 日本語

**VAZ** = **V**ercel AI SDK(堅牢な LLM ストリーミング)× Next.js 16 **A**pp Router(サーバー/クライアント統合アーキテクチャ)× **Z**od v4(厳格なランタイム型検証)。

React Compiler による最適化ボイラープレートの排除と、Rust 製高速ツールチェーン(Turbopack・Biome・Vitest)により、開発体験と実行速度の最高峰を目指すリポジトリです。

### はじめに

前提: [mise](https://mise.jdx.dev) をインストール済みであること(Node 24 LTS と pnpm 11.9 は `mise.toml` の固定バージョンで mise が用意します)。

```bash
mise install        # Node 24 / pnpm 11.9.0 を用意
pnpm install        # 依存をインストール(git フックも自動で有効化)
cp .env.example .env.local
mise run dev        # 開発サーバーを http://localhost:3000 で起動
```

### AI プロバイダーの切替

チャット API は環境変数からモデルをリクエスト時に解決します(Zod で検証 — `src/lib/ai/env.ts`)。

- **Anthropic(デフォルト)**: `.env.local` に `ANTHROPIC_API_KEY` を設定(モデルは `claude-opus-4-8`)
- **ローカル LLM(Ollama、API キー不要)**:

```bash
ollama pull llama3.2
AI_PROVIDER=ollama pnpm dev
```

### 品質ゲート(git フック)

`pnpm install` で `.githooks/` のフックが有効化されます:

- **pre-commit** — lint/format(biome)→ 型チェック → 単体テスト → `pnpm audit`
- **pre-push** — Playwright E2E。ローカルで Ollama を検出すると自動的に `AI_PROVIDER=ollama` で実行し、ローカル LLM とのチャット実往復テストも走ります

緊急時は `--no-verify` でスキップできます。

### サプライチェーン対策

`pnpm audit`(既知 CVE 照合)だけでは防げない攻撃を `pnpm-workspace.yaml` で補完しています。

- `minimumReleaseAge: 1440`: 公開から 24 時間未満のバージョンを解決しない(不正バージョン公開直後の最危険期間を回避)
- `allowBuilds`: 依存の install スクリプトはデフォルトでブロックし、判断を明示的に記録(現在すべて拒否)
- pnpm 自体のバージョンを `mise.toml` で固定
- CI で `pnpm install --frozen-lockfile` + `pnpm audit --audit-level=moderate`

アーキテクチャ移行の意思決定の記録は [`docs/MIGRATION_TO_NEXT.md`](docs/MIGRATION_TO_NEXT.md) を参照してください。

## ⚖️ License

[MIT](LICENSE)
