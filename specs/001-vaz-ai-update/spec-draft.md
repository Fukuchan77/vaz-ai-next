# 001-vaz-ai-update Requirements Specification（Draft）

> **ステータス**: `draft`（`/sdd-spec` 正式化前の下書き）。
> 本ドラフトは Google Drive の `vaz-ai-next-update-plan.md`(アップデート計画書)を
> 出発点に、`fukuchan77/pydantic-ai-sandbox` の実構成を参照して要件へ落とし込んだもの。
> 計画書は「sandbox リポジトリは非公開のため未参照」と注記していたが、本ドラフトでは
> sandbox を実参照し、その **SDD（Spec-Driven Development）プロセス・EARS 要件形式・
> `patterns/` パターン集**を対応付けの基準として補正済み（計画書 注記 §0 の指示を実行）。
>
> 次アクション: 本ドラフトを人間レビュー → `/sdd-spec` で `spec.md` に昇格 →
> `/sdd-design`（`plan.md` / `research.md`）→ `/sdd-tasks`（`tasks.md`）。

## Overview

現在の vaz-ai-next はシングル機能チャットアプリ（`src/app/api/chat/route.ts` に
`streamText` + tools がほぼ直書き）である。本フィーチャは、これを
**Pydantic AI（Python）の設計思想に相当する構造** を持つ
**RAG + マルチエージェント・ワークフロー自動化基盤**（長時間実行コンテナ前提の
社内業務ツール）へ、後方互換を保ちながら段階的（Phase 1〜5）に進化させる。

技術方針は先行リサーチレポート推奨に準拠する: **Vercel AI SDK 7 を軸**に、
耐久実行（durable execution）レイヤー、pgvector RAG、OpenTelemetry 可観測性を追加する。
既存の高い品質基盤（Biome / Vitest / Playwright / git hooks / supply-chain 対策 / CI）は
劣化させない。

## Project Description

### 現状（vaz-ai-next）

| 項目                          | 現状                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| 構造                          | Next.js 16 単一アプリ。チャットエンドポイントに tools 直書き        |
| エージェント抽象              | なし（`/api/chat` のみ）                                            |
| RAG                           | なし                                                               |
| マルチエージェント/ワークフロー | なし                                                               |
| 長時間実行                    | なし（HTTP リクエスト内で完結）                                     |
| 可観測性                      | なし                                                               |
| 評価（evals）                 | なし（Vitest 単体・Playwright E2E のみ）                            |
| 品質基盤                      | ◎（Biome / Vitest / Playwright / git hooks / supply-chain / CI）   |
| pnpm workspace                | 定義済みだがモノレポ未活用（単一パッケージ）                        |

### 参照: pydantic-ai-sandbox の実構成（本ドラフトで確認）

計画書の注記に反し sandbox は参照可能だった。以下は本要件の設計基準として採用する
実観測結果である:

- **SDD パイプライン**: `/sdd-init → /sdd-spec → /sdd-design → /sdd-tasks → /sdd-impl
  → /sdd-validate-impl → /sdd-reflect`。仕様は `specs/{feature}/`（`spec.md` /
  `spec.json` / `plan.md` / `research.md` / `tasks.md` / `pdca/`）に集約。**本ドラフトは
  この形式に合わせる。**
- **EARS 要件形式**: Ubiquitous (U) / Event-driven (E) / State-driven (S) /
  Optional (O) / Unwanted-behavior (X) の 5 パターンで、各 Acceptance Criteria を
  テスト可能に記述。
- **プロバイダ抽象の env 駆動**: `ModelFactory` + `FallbackModel`、モデル ID を
  ソースへ直書き禁止（`forbid-hardcoded-model-ids` フック）。vaz-ai-next の
  `resolveModel()`（env 駆動）と思想が一致 → **踏襲**。
- **`patterns/` パターン集**（Anthropic「Building Effective Agents」×IBM 粒度区分の二軸）:
  `prompt-chaining` / `routing` / `parallelization` / `orchestrator-workers` /
  `evaluator-optimizer` / `autonomous-agent` の 6 ワークフロー、および応用レイヤ
  `rag` / `sse`（進捗ストリーミング）/ `deep-research`（マルチエージェント調査）/
  横断契約 `eval-graders`（outcome+behavior 多軸採点）。**Phase 2〜4 の設計対応表
  （§Sandbox パターン対応）で各 Phase にマップする。**
- **契約中央集約 + ドリフトテスト**: 型契約を 1 箇所に集約し、README 正本と
  パッケージ実体の一致を単一テストで検知。→ vaz では `packages/schemas`（Zod）へ
  対応させる。

### Pydantic AI 概念 → VAZ（TypeScript）スタック対応表（設計原則）

| Pydantic AI (Python)                              | vaz-ai-next での対応 (TypeScript)                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Agent(model, deps_type=..., output_type=...)`    | AI SDK 7 Agent（ツールループ）+ Zod 出力スキーマ                                          |
| `RunContext[Deps]`（型付き依存注入）              | Agent ファクトリへの deps 注入（closure / `experimental_context`）。Deps 型は `packages/schemas` で共有 |
| `@agent.tool` + Pydantic スキーマ                 | `tool({ inputSchema: z.object(...) })`（Zod v4）                                          |
| `output_type` 構造化出力                          | `generateObject` / `Output.object`（Zod スキーマ）                                        |
| capabilities（ツール+hook+instructions の合成単位）| capability パッケージパターン: `packages/tools/` でツール束+プロンプト断片+設定を 1 export に |
| Human-in-the-Loop ツール承認                      | AI SDK の `needsApproval` + ワークフロー中断/再開                                          |
| Durable Execution（temporal / dbos）              | ワークフローエンジン（Phase 3 で Inngest / Temporal TS / BullMQ から選定）                |
| `pydantic-evals`                                  | 評価ハーネス（Vitest + evalite or promptfoo）を `packages/evals/` に                       |
| Logfire（OTel）                                   | OpenTelemetry + Langfuse（セルフホスト可、社内ツール向き）                                 |
| `TestModel` / `FunctionModel`                     | AI SDK `MockLanguageModel`（`ai/test`）+ モック deps 注入                                  |
| MCP 統合                                          | AI SDK MCP クライアント（必要時に導入）                                                    |

## Clarifications

> ドラフト段階の未決事項。`/sdd-spec` 昇格前に Q&A で確定させる（`[NEEDS CLARIFICATION]`）。

- **Q1 [ワークフローエンジン]**: Phase 3 の耐久実行エンジンは Inngest / Temporal (TS SDK) /
  BullMQ のいずれか。HITL（承認待ちで数時間〜数日中断→再開）を要件に含めるため計画書は
  Inngest または Temporal を推奨。→ `[NEEDS CLARIFICATION: 社内基盤に Temporal が既にあるか？
  Phase 3 冒頭スパイクで両候補比較]`
- **Q2 [埋め込みプロバイダ]**: Anthropic は埋め込み非提供。`AI_EMBEDDING_PROVIDER` で
  OpenAI / Ollama（`nomic-embed-text` 等）/ Voyage を選択。→ `[NEEDS CLARIFICATION:
  社内で外部 API（OpenAI/Voyage）送信が許容されるか。不可なら Ollama ローカル埋め込み固定]`
- **Q3 [可観測性の前倒し範囲]**: 計画書は Langfuse トレーシングを Phase 1 完了時点で導入推奨。
  MVP（Phase 1）で OTel 計装まで入れるか、トレース基盤（Langfuse）まで入れるか。→
  `[NEEDS CLARIFICATION: Phase 1 は OTel 計装のみ / Langfuse まで]`
- **Q4 [認証]**: Phase 5 の社内 IdP（Entra ID / Google Workspace）OIDC 連携先。→
  `[NEEDS CLARIFICATION: Auth.js か社内標準か]`
- **Q5 [MVP スコープ]**: Phase 1 の完了を「既存チャットのエージェント層移設 + モック
  テスト」に限定し、RAG/ワークフローは Phase 2 以降に厳密分離する方針でよいか。→
  `[NEEDS CLARIFICATION: 確認]`

## Requirements

> 各 Acceptance Criteria は sandbox に倣い EARS 形式（U/E/S/O/X）で記述し、テスト可能で
> あることを必須とする。`<system>` の主体は本アプリケーション（`@vaz/*` ワークスペース）を指す。
> 要件は計画書の Phase 1–5 に 1:1 対応する。
>
> EARS 凡例: U=`The <system> SHALL <response>` / E=`WHEN <trigger> ...` /
> S=`WHILE <state> ...` / O=`WHERE <feature> ...` / X=`IF <condition> THEN ...`

### Requirement 1: モノレポ化とエージェント層の抽出（Phase 1）

**User Story**: 開発者として、UI から独立してテスト・実行できるエージェント層を持ちたい。
理由: 「チャットアプリ」から「エージェントをコアに持つアプリ」へ移行し、以降の全 Phase の
土台（Pydantic AI の型付き deps / Agent 抽象の移植）を成立させるため。

**Acceptance Criteria**:

- 1.1 [U] The system SHALL be organized as a pnpm workspace with `apps/web/`（既存 Next.js を移設）
  and `packages/{agents,tools,schemas,config}/`; `pnpm-workspace.yaml` SHALL list `apps/*` と `packages/*`.
- 1.2 [U] The system SHALL preserve existing supply-chain guards (`minimumReleaseAge`, `allowBuilds`)
  unchanged across the workspace migration.
- 1.3 [U] `packages/agents` SHALL expose a `createChatAgent(deps)` factory that receives typed
  `AgentDeps`（`db` / `logger` / `now` 等）by closure, mirroring Pydantic AI `RunContext[Deps]`.
- 1.4 [U] Tools SHALL be defined via `tool({ description, inputSchema: <Zod>, execute })` and their
  `execute` SHALL read `deps` from closure so agents are unit-testable by injecting mock deps.
- 1.5 [U] `src/app/api/chat/route.ts` SHALL be reduced to a thin HTTP⇔Agent adapter that imports
  `@vaz/agents`; agent orchestration logic SHALL NOT live in the route handler.
- 1.6 [U] Agent unit tests SHALL run without any LLM API using AI SDK `MockLanguageModel`（`ai/test`）
  and SHALL NOT require network access.
- 1.7 [S] WHILE the Anthropic/Ollama provider is selected only by env var, `/api/chat` SHALL behave
  identically to the pre-migration app（回帰なし）.
- 1.8 [X] IF a source file under `packages/` or `apps/` hardcodes an LLM model identifier THEN the lint
  stage SHALL fail; model IDs SHALL come from env（sandbox `forbid-hardcoded-model-ids` に相当、
  既存 `resolveModel()` の env 駆動を踏襲）.
- 1.9 [U] Existing git hooks (`.githooks/`: biome + tsc + vitest + audit / pre-push E2E) and CI SHALL
  pass green under the monorepo layout（`pnpm -r` / `--filter` 対応の mise タスクを含む）.

### Requirement 2: RAG 層の構築（Phase 2）

**User Story**: 利用者として、社内ドキュメントを根拠に引用付きで回答してほしい。
理由: エージェントに検索ツールを供給し、社内業務ツールとしての有用性を成立させるため。

**Acceptance Criteria**:

- 2.1 [U] The system SHALL provide `packages/rag/` with `ingest/`（loader→chunking→embed→upsert）と
  `retrieve/`（vector search）and SHALL export retrieval as a capability（ツール束）in `tools.ts`.
- 2.2 [U] The vector store SHALL be PostgreSQL + pgvector, provisioned for development via
  `docker-compose.yml`; schema access SHALL use Drizzle ORM（`drizzle-zod` 連携）.
- 2.3 [O] WHERE `AI_EMBEDDING_PROVIDER ∈ {openai, ollama, voyage}` is selected, `embed.ts` SHALL use
  AI SDK `embedMany` via the shared provider layer; the Zod env schema（`packages/schemas` の env）
  SHALL be extended to validate the embedding provider config.
- 2.4 [U] The chat agent SHALL cite retrieved internal documents in its answer via the retrieval tool
  （`RetrievedChunk` / `Citation` 相当の型付き契約、sandbox `patterns/rag` の契約に対応）.
- 2.5 [U] A retrieval golden set（質問→期待ドキュメント ID、20〜50 件）SHALL exist and a `recall@k`
  test SHALL run in CI using embeddings only（LLM 不要）.
- 2.6 [U] `pnpm --filter @vaz/rag ingest ./docs` SHALL ingest a document corpus end-to-end.
- 2.7 [O] WHERE reranking is enabled it MAY be added later; the MVP retrieval path SHALL function without
  a reranker.

### Requirement 3: 長時間実行ワーカーとワークフロー / HITL（Phase 3）

**User Story**: 運用者として、HTTP タイムアウトに縛られない長時間ジョブを別コンテナで実行し、
承認待ちで中断・再開できるようにしたい。理由: 社内業務の自動化（多段・耐久・監査）を
Pydantic AI 的な「型付きハンドオフ」で成立させるため。

**Acceptance Criteria**:

- 3.1 [U] The system SHALL add `apps/worker/`（Node 24 長時間プロセス）that imports `@vaz/agents` /
  `@vaz/rag` and SHALL be containerized（Dockerfile + docker-compose）.
- 3.2 [U] A durable workflow engine（Inngest / Temporal TS / BullMQ, decided by a Phase 3 spike）SHALL
  drive control flow; job submission from `apps/web` SHALL be decoupled from execution in `apps/worker`.
- 3.3 [U] Multi-agent composition SHALL be expressed as **workflow steps**（supervisor が計画・分配 →
  専門エージェント: RAG 調査 / 文書生成 / データ処理）rather than free-form agent-to-agent chat;
  each step I/O SHALL be fixed by a Zod schema（`packages/schemas/workflows.ts`）as a typed handoff.
- 3.4 [O] WHERE a tool is destructive（メール送信・社内システム書込み等）it SHALL declare
  `needsApproval`; the workflow SHALL suspend awaiting approval and `apps/web` SHALL present an
  approval UI（承認 / 却下 / 引数編集）.
- 3.5 [E] WHEN an approval event is received the suspended workflow SHALL resume from its checkpoint.
- 3.6 [U] Job progress events（step 開始 / tool 呼び出し / token / 完了 / エラー）SHALL be written to
  DB or Redis pub/sub and streamed to the browser via an SSE Route Handler consumed by a `useJobStream`
  hook（sandbox `patterns/sse` の型付きイベント判別共用体に対応）.
- 3.7 [S] WHILE a multi-step job exceeding 10 minutes is running, it SHALL complete even across a worker
  restart（耐久実行の実証）.
- 3.8 [E] WHEN a job is suspended for approval and approved the next day THEN the resume-and-complete
  scenario SHALL pass an E2E test.

### Requirement 4: 可観測性と評価（Phase 4）

**User Story**: 開発者として、全エージェント実行をトレースし、ゴールデンセット評価で品質退行を
検知したい。理由:「動く」から「運用・改善できる」へ（Pydantic AI + Logfire / pydantic-evals 相当）。

**Acceptance Criteria**:

- 4.1 [U] The system SHALL enable AI SDK `experimental_telemetry`（OTel）on all agent calls and export
  traces to Langfuse（セルフホスト可）.
- 4.2 [U] Each trace SHALL carry `jobId` / `userId` / agent name so a whole workflow is followable as a
  single trace; token/cost usage SHALL be visible in the Langfuse dashboard.
- 4.3 [X] IF `LANGFUSE`（トークン等）is unset THEN the app SHALL still start and serve（fail-soft）with
  a single warning; observability failures SHALL NOT propagate to API responses（sandbox R5 fail-soft に対応）.
- 4.4 [U] `packages/evals/` SHALL implement a 3-tier harness: (1) unit（MockModel でツール選択・ループ
  制御・スキーマ準拠、CI 毎回）, (2) RAG `recall@k`（CI 毎回、Req 2.5）, (3) LLM eval（実モデル +
  LLM-as-judge, nightly/手動）using evalite or promptfoo, recording results to Langfuse.
- 4.5 [U] The LLM-as-judge grader SHALL separate **outcome**（最終成果物）and **behavior**（過程）
  axes（sandbox `patterns/eval-graders` の `GradeReport` 契約に対応）.
- 4.6 [U] CI SHALL add an `eval:nightly` workflow gated by GitHub Secrets with a cost cap; a score
  regression against the golden set SHALL be detectable.
- 4.7 [U] The system SHALL NOT log raw user prompts or full tool I/O at INFO by default; sensitive
  payload logging SHALL be opt-in.

### Requirement 5: セキュリティ強化（Phase 5）

**User Story**: メンテナとして、社内ツール要件（認証認可・プロンプトインジェクション対策・監査）
を満たしたい。理由: 信頼できない文書を扱う RAG + 破壊的ツールを持つワークフローを安全に運用するため。

**Acceptance Criteria**:

- 5.1 [U] The system SHALL authenticate users via 社内 IdP OIDC（Entra ID / Google Workspace）and SHALL
  scope tool execution to the user's permissions through `deps`（エージェントにユーザー権限以上を
  させない）.
- 5.2 [U] RAG-ingested documents SHALL be treated as untrusted input: retrieval results SHALL be injected
  as an explicitly delimited context block, NOT merged into the system prompt.
- 5.3 [X] IF a turn is driven by externally-read content（RAG 等）THEN destructive tools SHALL be
  disabled or SHALL require HITL approval（lethal trifecta / Rule of Two 準拠）.
- 5.4 [O] WHERE a tool sends data externally（メール等）it SHALL enforce a recipient allow-list.
- 5.5 [U] Every tool execution（誰が・どのジョブで・何を引数に）SHALL be recorded to an audit log in DB
  （ワークフローエンジン採用でほぼ自動取得）.

## Acceptance Criteria（Cross-Cutting / NFR / Traceability）

### Cross-Cutting / Non-Functional

- **NFR-1（品質基盤非劣化）**: 既存の Biome / Vitest / Playwright / git hooks / supply-chain /
  CI は全 Phase を通じて緑を維持する（Req 1.9）。
- **NFR-2（再現性）**: 任意の開発機で `git clone` → `pnpm install` → `mise run <check>` により
  全ゲートが通過する。
- **NFR-3（環境変数中心主義）**: モデル ID・プロバイダ選択・埋め込みプロバイダ・トークンは全て
  env で表現しソースへ直書きしない（Req 1.8 / 2.3）。
- **NFR-4（起動レジリエンス）**: Langfuse/DB/Ollama 未設定でもアプリは起動でき、当該機能呼び出し
  時にのみエラー化する（Req 4.3 fail-soft）。
- **NFR-5（後方互換の段階移行）**: 各 Phase は独立に検証可能で、Phase 1 完了時点で既存チャット機能
  は完全に等価（Req 1.7）。
- **NFR-6（型付きハンドオフ）**: エージェント/ワークフロー間 I/O は Zod スキーマで固定し、
  `packages/schemas` を単一正本とする（sandbox の契約中央集約 + ドリフトテストに対応）。
- **NFR-7（前倒し推奨）**: Langfuse トレーシング（Req 4.1–4.2）は Phase 1 完了時点で導入し、
  以降の全 Phase のデバッグ効率を確保する（Q3 で確定）。

### 実施順序とマイルストーン

| Phase | 内容                         | 目安        | 依存                          |
| ----- | ---------------------------- | ----------- | ----------------------------- |
| 1     | モノレポ化 + Agent 層        | 1〜2 週     | なし                          |
| 2     | RAG 層 + 検索評価            | 2〜3 週     | Phase 1                       |
| 3     | ワーカー + ワークフロー + HITL | 3〜4 週     | Phase 1（2 と並行可）         |
| 4     | 可観測性 + 評価              | 1〜2 週     | Phase 1（OTel は 1 に前倒し） |
| 5     | セキュリティ                 | 1〜2 週     | Phase 3                       |

### Traceability Matrix（要件 → 出典）

| Req                 | 主要出典                                                                 |
| ------------------- | ------------------------------------------------------------------------ |
| R1 モノレポ+Agent   | 計画書 Phase 1、対応表（deps/Agent）、sandbox EARS/env 駆動プロバイダ     |
| R2 RAG              | 計画書 Phase 2、sandbox `patterns/rag`（`RetrievedChunk`/`Citation`）     |
| R3 ワークフロー/HITL | 計画書 Phase 3、sandbox `orchestrator-workers` / `deep-research` / `sse`  |
| R4 可観測性+評価    | 計画書 Phase 4、sandbox `patterns/eval-graders`（`GradeReport`）          |
| R5 セキュリティ     | 計画書 Phase 5、sandbox `patterns/SECURITY-NOTES.md`（OWASP Agentic Top10）|

### Sandbox パターン対応（`patterns/` → 本フィーチャ Phase）

| sandbox パターン                    | 対応 Phase / 要件                                         |
| ----------------------------------- | -------------------------------------------------------- |
| 単一エージェント（構造化出力・型付きツール） | Phase 1 / R1（`createChatAgent` + Zod 出力）            |
| `routing`                           | Phase 3 / R3.3（supervisor の分類→専門エージェント分配） |
| `orchestrator-workers`              | Phase 3 / R3.3（動的計画→並列実行→統合）                 |
| `parallelization`                   | Phase 3 / R3.3（fan-out する専門エージェント）           |
| `evaluator-optimizer`               | Phase 4 / R4.4–4.5（生成⇄評価ループ）                    |
| `autonomous-agent`                  | Phase 1/3（ツールループ + `stopWhen` ガードレール）      |
| `rag`（応用レイヤ）                 | Phase 2 / R2                                             |
| `sse`（応用レイヤ）                 | Phase 3 / R3.6（進捗イベント配信）                       |
| `deep-research`（応用レイヤ）       | Phase 3 / R3.3（有界並列マルチエージェント調査）         |
| `eval-graders`（横断契約）          | Phase 4 / R4.5（outcome+behavior 多軸採点）              |

### Out of Scope（本フィーチャ範囲外 / 将来 spec）

- Python 側 sandbox 実装そのものの移植（本リポジトリは TypeScript / AI SDK 7 が正）。sandbox は
  設計思想・パターン契約の参照元に留める。
- MCP クライアント統合（AI SDK MCP、必要になった時点で別 spec）。
- Cohere Rerank 等の再ランク（Req 2.7、後続）。
- 本番向け課金最適化・マルチテナント・SLA 設計。
- Vision / マルチモーダル入力（現行スコープはテキストチャット + RAG + ワークフロー）。

## リスクと対処

| リスク                                          | 対処                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| AI SDK / Next.js のメジャーバージョン変動が速い | `minimumReleaseAge` 済 + Renovate/Dependabot を「グループ化 + 週次」で導入 |
| ワークフローエンジン選定ミス                    | Phase 3 冒頭スパイクで「承認待ち中断→再開」を両候補で実装比較してから決定  |
| sandbox 固有設計との乖離                        | 本ドラフトで実参照済み。パターン契約を `packages/schemas` にマップして追従 |
| RAG 品質が上がらない                            | Phase 2 で `recall@k` 評価基盤を先行整備し、チューニングを計測駆動に        |
