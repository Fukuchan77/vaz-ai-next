# 001-vaz-ai-update

## Project Description

現在の vaz-ai-next はシングル機能チャットアプリ（`src/app/api/chat/route.ts` に
`streamText` + tools がほぼ直書き）である。本フィーチャは、これを **Pydantic AI（Python）
の設計思想に相当する構造** を持つ **RAG + マルチエージェント・ワークフロー自動化基盤**
（長時間実行コンテナ前提の社内業務ツール）へ、後方互換を保ちながら段階的（Phase 1〜5）に
進化させる。

技術方針は先行リサーチレポート推奨に準拠する: **Vercel AI SDK 7 を軸**に、耐久実行
（durable execution）レイヤー、pgvector RAG、OpenTelemetry 可観測性を追加する。既存の
高い品質基盤（Biome / Vitest / Playwright / git hooks / supply-chain 対策 / CI）は
劣化させない。

> **出典**: 本 spec は Git 管理外の 2 ドキュメントを出発点とする — アップデート計画書
> （`vaz-ai-next-update-plan.md.docx`）と `spec-draft.md`。両者の要点は本ファイルに取り込み
> 済み（以下）。計画書は当初「pydantic-ai-sandbox は非公開のため未参照」としていたが、
> ドラフト作成時に sandbox を実参照し、その **SDD プロセス / EARS 要件形式 / `patterns/`
> パターン集** を設計基準として補正済み。

### Pydantic AI 概念 → VAZ（TypeScript）スタック対応表（設計原則）

| Pydantic AI (Python)                              | vaz-ai-next での対応 (TypeScript)                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `Agent(model, deps_type, output_type)`            | AI SDK 7 Agent（ツールループ）+ Zod 出力スキーマ                          |
| `RunContext[Deps]`（型付き依存注入）              | Agent ファクトリへの deps 注入（closure / `experimental_context`）        |
| `@agent.tool` + Pydantic スキーマ                 | `tool({ inputSchema: z.object(...) })`（Zod v4）                          |
| `output_type` 構造化出力                          | `generateObject` / `Output.object`（Zod スキーマ）                        |
| capabilities（ツール+hook+instructions の合成単位）| capability パッケージパターン（`packages/tools/` で 1 export に束ねる）   |
| Human-in-the-Loop ツール承認                      | AI SDK `needsApproval` + ワークフロー中断/再開                            |
| Durable Execution（temporal / dbos）              | ワークフローエンジン（Phase 3 で選定）                                    |
| `pydantic-evals`                                  | 評価ハーネス（Vitest + evalite or promptfoo）を `packages/evals/`         |
| Logfire（OTel）                                   | OpenTelemetry + Langfuse（セルフホスト可）                                |
| `TestModel` / `FunctionModel`                     | AI SDK `MockLanguageModel`（`ai/test`）+ モック deps 注入                 |
| MCP 統合                                          | AI SDK MCP クライアント（必要時に導入）                                   |

### Phase 概要（計画書 Phase 1〜5 に 1:1 対応）

| Phase | 内容                                   | 目安    | 依存                          |
| ----- | -------------------------------------- | ------- | ----------------------------- |
| 1     | モノレポ化 + Agent 層の抽出            | 1〜2 週 | なし                          |
| 2     | RAG 層（pgvector + Drizzle）+ 検索評価 | 2〜3 週 | Phase 1                       |
| 3     | 長時間実行ワーカー + ワークフロー + HITL | 3〜4 週 | Phase 1（2 と並行可）         |
| 4     | 可観測性（OTel/Langfuse）+ 評価        | 1〜2 週 | Phase 1（OTel は 1 に前倒し） |
| 5     | セキュリティ（認証認可・PI 対策・監査）| 1〜2 週 | Phase 3                       |

## Clarifications

<!--
Populated by /sdd-init. Each session is recorded as:
### Session YYYY-MM-DD
- Q: <question> → A: <answer>
-->

### Session 2026-07-04

- Q: [MVP スコープ] Phase 1 の完了を「既存チャットのエージェント層移設 + モックテスト」に限定し、RAG/ワークフローは Phase 2 以降へ厳密分離する方針でよいか？ → A: **厳密分離**（推奨）。Phase 1 = 既存チャットの `@vaz/agents` 化 + `MockLanguageModel` 単体テスト + 回帰なし、まで。RAG/ワークフローは着手しない。
- Q: [ワークフローエンジン] Phase 3 の耐久実行エンジン（HITL 承認待ち中断→再開を含む）をどう決めるか？ → A: **Phase 3 冒頭スパイクで Inngest と Temporal (TS SDK) を実装比較して確定**（推奨）。現時点で単一エンジンには確定しない。BullMQ 単体は中断/再開・HITL 自作の負債リスクとして除外寄り。
- Q: [埋め込みプロバイダ] 社内文書を外部 API へ送信する可否は？ → A: **env 駆動・既定 Ollama ローカル**（推奨）。`AI_EMBEDDING_PROVIDER` で切替、既定は Ollama（`nomic-embed-text` 等）ローカル。社内ポリシーが許せば OpenAI/Voyage も選択可。
- Q: [可観測性の前倒し範囲] OTel/Langfuse の導入タイミングは？ → A: **Phase 1 完了時点で Langfuse まで前倒し導入**（推奨、NFR-7）。`experimental_telemetry`（OTel）を Phase 1 から全エージェント呼び出しで有効化しトレースを Langfuse へ。
- Q: [認証] Phase 5 の社内 IdP OIDC 連携先（Entra ID / Google Workspace / Auth.js か社内標準か）は？ → A: **Phase 5 で詳細決定（現時点は deferred）**（推奨）。設計制約「ツール実行を deps 経由でユーザー権限にスコープ」は維持し、IdP 連携方式は Phase 5 開始時に確定。

## Scope

- **In scope**（今回フィーチャの範囲、Phase 1〜5 の段階的進化）:
  - **Phase 1**: pnpm モノレポ化（`apps/web` + `packages/{agents,tools,schemas,config}`）と Agent 層の抽出。`route.ts` を薄い HTTP⇔Agent アダプタへ縮退。`MockLanguageModel` による LLM 非依存の単体テスト。回帰なし。**（MVP 境界＝ここまで／RAG・ワークフローは含めない）**
  - **Phase 2**: RAG 層（PostgreSQL + pgvector, Drizzle ORM）。埋め込みは env 駆動・既定 Ollama ローカル。`recall@k` ゴールデンセット評価。
  - **Phase 3**: 長時間実行ワーカー（`apps/worker`）+ 耐久ワークフロー（Inngest/Temporal をスパイクで選定）+ HITL（`needsApproval` 中断/再開）+ SSE 進捗。
  - **Phase 4**: 可観測性（OTel + Langfuse、Phase 1 に前倒し）+ 3 層評価ハーネス（unit / RAG recall@k / LLM-as-judge）。
  - **Phase 5**: セキュリティ（社内 IdP OIDC 連携=方式は Phase 5 で確定、プロンプトインジェクション対策、監査ログ）。
- **Out of scope**:
  - Python 側 sandbox 実装そのものの移植（本リポジトリは TypeScript / AI SDK 7 が正）
  - MCP クライアント統合（必要になった時点で別 spec）
  - Cohere Rerank 等の再ランク（Phase 2 の後続）
  - 本番向け課金最適化・マルチテナント・SLA 設計
  - Vision / マルチモーダル入力（現行スコープはテキストチャット + RAG + ワークフロー）

## Glossary

| 用語 | 定義 |
|------|------|
| Agent | AI SDK 7 のツールループ実行単位。`createChatAgent(deps)` ファクトリで生成する（Pydantic AI `Agent` 相当）。 |
| Deps | エージェント/ツールへ closure で注入する型付き依存（`db` / `logger` / `now` 等）。Pydantic AI `RunContext[Deps]` 相当。 |
| capability | ツール束 + プロンプト断片 + 設定を 1 export にまとめたパッケージ単位（`packages/tools/`, `packages/rag/tools.ts`）。 |
| HITL | Human-in-the-Loop。破壊的ツールを承認待ちで中断し、承認イベントで再開する制御。 |
| durable execution | ワーカー再起動を跨いでもジョブが完走する耐久実行。ワークフローエンジンが担保。 |
| recall@k | 検索評価指標。ゴールデンセットの期待ドキュメントが上位 k 件に含まれる割合。 |
| golden set | 質問→期待ドキュメント ID（RAG）/ 入力→期待挙動（eval）の正解データ集合。 |
| GradeReport | LLM-as-judge の採点結果契約。outcome（成果物）と behavior（過程）を別軸で持つ。 |

## Requirements

<!--
EARS 形式（rules/ears-format.md）。要件見出しは先頭数値 ID のみ。受入基準は
階層番号（1.1, 1.2 …）で採番し、これが plan.md / tasks.md / /sdd-analyze の
トレーサビリティキーとなる。各基準の [U]/[E]/[S]/[O]/[X] は EARS パターン注記。
-->

> **主体（subject）規約**: 原則として **THE VAZ platform**（`@vaz/*` ワークスペース総体）を
> 主語とする。個別サブシステムが行為主体となる基準では、その具体名（`THE lint stage` /
> `THE chat agent` / `THE workflow` / `THE ingest path` 等）を主語として明示する。
> EARS 凡例: U=Ubiquitous / E=Event-driven (WHEN) / S=State-driven (WHILE) /
> O=Optional feature (WHERE) / X=Unwanted (IF…THEN)。要件 1〜5 は Phase 1〜5 に 1:1 対応。

### Requirement 1: モノレポ化とエージェント層の抽出（Phase 1）

**User Story**: 開発者として、UI から独立してテスト・実行できるエージェント層を持ちたい。
理由: 「チャットアプリ」から「エージェントをコアに持つアプリ」へ移行し、以降の全 Phase の
土台（型付き deps / Agent 抽象）を成立させるため。

**Acceptance Criteria**:

1.1 [U] THE VAZ platform SHALL be organized as a pnpm workspace containing `apps/web/` (the migrated Next.js app) and `packages/{agents,tools,schemas,config}/`, and `pnpm-workspace.yaml` SHALL list both `apps/*` and `packages/*`.
1.2 [U] THE VAZ platform SHALL preserve the existing supply-chain guards (`minimumReleaseAge`, `allowBuilds`) unchanged after the workspace migration.
1.3 [U] `packages/agents` SHALL expose a `createChatAgent(deps)` factory that receives a typed `AgentDeps` value (`db`, `logger`, `now`, …) by closure.
1.4 [U] Every tool SHALL be defined via `tool({ description, inputSchema: <Zod schema>, execute })`, and its `execute` SHALL read `deps` from closure so agents are unit-testable by injecting mock deps.
1.5 [U] `apps/web` `src/app/api/chat/route.ts` SHALL contain only HTTP⇔Agent adapter logic and SHALL import agent orchestration from `@vaz/agents`; orchestration logic SHALL NOT live in the route handler.
1.6 [U] THE agent unit tests SHALL run using AI SDK `MockLanguageModel` (`ai/test`) without any LLM API call or network access.
1.7 [S] WHILE the provider is selected only by environment variables, `/api/chat` SHALL return responses equivalent to the pre-migration app (no regression, Anthropic↔Ollama switch included).
1.8 [X] IF a source file under `packages/` or `apps/` hardcodes an LLM model identifier, THEN THE lint stage SHALL fail (model IDs come from env, per `resolveModel()`).
1.9 [U] THE existing git hooks (biome + tsc + vitest + audit; pre-push E2E) and CI SHALL pass green under the monorepo layout, with `pnpm -r` / `--filter` aware mise tasks.
1.10 [U] THE Phase 1 deliverable SHALL be limited to the agent-layer migration and mock-based tests; RAG and workflow capabilities SHALL NOT be introduced in Phase 1 (strict phase separation).

### Requirement 2: RAG 層の構築（Phase 2）

**User Story**: 利用者として、社内ドキュメントを根拠に引用付きで回答してほしい。
理由: エージェントに検索ツールを供給し、社内業務ツールとしての有用性を成立させるため。

**Acceptance Criteria**:

2.1 [U] THE VAZ platform SHALL provide `packages/rag/` with an `ingest/` path (loader → chunking → embed → upsert) and a `retrieve/` path (vector search), and SHALL export retrieval as a capability in `tools.ts`.
2.2 [U] THE RAG vector store SHALL be PostgreSQL with the pgvector extension, provisioned for development via `docker-compose.yml`, and schema access SHALL use Drizzle ORM (`drizzle-zod`).
2.3 [O] WHERE `AI_EMBEDDING_PROVIDER` selects a provider, THE embedding path SHALL default to Ollama local embeddings, SHALL use AI SDK `embedMany` via the shared provider layer, and the Zod env schema (`packages/schemas`) SHALL validate the embedding provider configuration.
2.4 [U] THE chat agent SHALL cite the retrieved internal documents in its answer via the retrieval tool, using typed `RetrievedChunk` / `Citation` contracts.
2.5 [U] THE RAG retrieval SHALL be covered by a golden set of 20–50 question→expected-document-ID pairs, and a `recall@k` test SHALL run in CI using embeddings only (no LLM).
2.6 [E] WHEN `pnpm --filter @vaz/rag ingest ./docs` is run, THE ingest path SHALL ingest the document corpus end-to-end.
2.7 [U] THE MVP retrieval path SHALL function without a reranker (reranking is deferred — see Out of Scope / Future Work).

### Requirement 3: 長時間実行ワーカーとワークフロー / HITL（Phase 3）

**User Story**: 運用者として、HTTP タイムアウトに縛られない長時間ジョブを別コンテナで実行し、
承認待ちで中断・再開できるようにしたい。理由: 社内業務の自動化（多段・耐久・監査）を
型付きハンドオフで成立させるため。

**Acceptance Criteria**:

3.1 [U] THE VAZ platform SHALL add `apps/worker/` (a long-running Node 24 process) that imports `@vaz/agents` and `@vaz/rag`, and it SHALL be containerized (Dockerfile + docker-compose).
3.2 [U] A durable workflow engine — selected by a Phase 3 spike comparing Inngest and Temporal (TS SDK) — SHALL drive control flow, and job submission from `apps/web` SHALL be decoupled from execution in `apps/worker`.
3.3 [U] THE multi-agent composition SHALL be expressed as workflow steps (a supervisor plans and dispatches to specialist agents: RAG research / document generation / data processing) rather than free-form agent-to-agent chat, and each step's I/O SHALL be fixed by a Zod schema in `packages/schemas/workflows.ts` as a typed handoff.
3.4 [O] WHERE a tool is destructive (email send, internal-system write, …), THE tool SHALL declare `needsApproval`, THE workflow SHALL suspend awaiting approval, and `apps/web` SHALL present an approval UI (approve / reject / edit arguments).
3.5 [E] WHEN an approval event is received, THE suspended workflow SHALL resume from its checkpoint.
3.6 [E] WHEN a job emits a progress event (step start, tool call, token, completion, error), THE VAZ platform SHALL persist it (DB or Redis pub/sub) and stream it to the browser via an SSE Route Handler consumed by a `useJobStream` hook, using a typed event discriminated union.
3.7 [S] WHILE a multi-step job exceeding 10 minutes is running, THE workflow SHALL complete even across a worker restart.
3.8 [E] WHEN a job is suspended for approval and approved the next day, THEN THE resume-and-complete scenario SHALL pass an E2E test.

### Requirement 4: 可観測性と評価（Phase 4／OTel は Phase 1 に前倒し）

**User Story**: 開発者として、全エージェント実行をトレースし、ゴールデンセット評価で品質退行を
検知したい。理由:「動く」から「運用・改善できる」へ進めるため。

**Acceptance Criteria**:

4.1 [U] THE VAZ platform SHALL enable AI SDK `experimental_telemetry` (OTel) on all agent calls from Phase 1 completion onward and SHALL export traces to Langfuse (self-hostable).
4.2 [U] Each trace SHALL carry `jobId`, `userId`, and agent name so an entire workflow is followable as a single trace, and token/cost usage SHALL be visible in the Langfuse dashboard.
4.3 [X] IF the Langfuse configuration (tokens, etc.) is unset, THEN THE VAZ platform SHALL still start and serve with a single warning, and observability failures SHALL NOT propagate to API responses (fail-soft).
4.4 [U] `packages/evals/` SHALL implement a 3-tier harness: (1) unit checks with `MockModel` (tool selection, loop control, schema conformance) every CI run, (2) RAG `recall@k` every CI run (Req 2.5), (3) LLM eval with a real model + LLM-as-judge run nightly/manually (evalite or promptfoo), recording results to Langfuse.
4.5 [U] THE LLM-as-judge grader SHALL score outcome (final artifact) and behavior (process) on separate axes, producing a typed `GradeReport`.
4.6 [E] WHEN the `eval:nightly` CI workflow runs (gated by GitHub Secrets), THE VAZ platform SHALL enforce a cost cap and SHALL make a score regression against the golden set detectable.
4.7 [U] THE VAZ platform SHALL NOT log raw user prompts or full tool I/O at INFO level by default; sensitive-payload logging SHALL be opt-in.

### Requirement 5: セキュリティ強化（Phase 5）

**User Story**: メンテナとして、社内ツール要件（認証認可・プロンプトインジェクション対策・監査）
を満たしたい。理由: 信頼できない文書を扱う RAG + 破壊的ツールを持つワークフローを安全に運用するため。

**Acceptance Criteria**:

5.1 [U] THE VAZ platform SHALL authenticate users via internal IdP OIDC (Entra ID / Google Workspace) and SHALL scope tool execution to the user's permissions through `deps`; the exact IdP integration method (Auth.js or an internal standard) SHALL be decided at Phase 5 start.
5.2 [U] THE RAG-ingested documents SHALL be treated as untrusted input, and retrieval results SHALL be injected as an explicitly delimited context block, NOT merged into the system prompt.
5.3 [X] IF a turn is driven by externally-read content (e.g. RAG results), THEN destructive tools SHALL be disabled or SHALL require HITL approval (lethal trifecta / Rule of Two).
5.4 [O] WHERE a tool sends data externally (email, …), THE tool SHALL enforce a recipient allow-list.
5.5 [U] THE VAZ platform SHALL record every tool execution (who, which job, with what arguments) to an audit log in the database.

## Non-Functional Requirements

- **NFR-1（品質基盤非劣化）**: THE VAZ platform SHALL keep Biome / Vitest / Playwright / git hooks / supply-chain / CI green across all phases (Req 1.9)。
- **NFR-2（再現性）**: WHEN a developer runs `git clone` → `pnpm install` → `mise run <check>` on any machine, THEN all quality gates SHALL pass。
- **NFR-3（環境変数中心主義）**: モデル ID・プロバイダ選択・埋め込みプロバイダ・トークンは全て env で表現し、ソースへ直書きしない（Req 1.8 / 2.3）。
- **NFR-4（起動レジリエンス）**: IF Langfuse / DB / Ollama が未設定 THEN THE VAZ platform SHALL still start, and error only when the corresponding capability is invoked（Req 4.3 fail-soft）。
- **NFR-5（後方互換の段階移行）**: 各 Phase は独立に検証可能で、Phase 1 完了時点で既存チャット機能は完全に等価（Req 1.7 / 1.10）。
- **NFR-6（型付きハンドオフ）**: エージェント/ワークフロー間 I/O は Zod スキーマで固定し、`packages/schemas` を単一正本とする（契約中央集約 + ドリフトテスト）。
- **NFR-7（可観測性の前倒し）**: Langfuse トレーシング（Req 4.1–4.2）は Phase 1 完了時点で導入し、以降の全 Phase のデバッグ効率を確保する（Clarification Q3 確定）。

## Traceability & Milestones

### 実施順序とマイルストーン

| Phase | 内容 | 目安 | 依存 |
|-------|------|------|------|
| 1 | モノレポ化 + Agent 層 | 1〜2 週 | なし |
| 2 | RAG 層 + 検索評価 | 2〜3 週 | Phase 1 |
| 3 | ワーカー + ワークフロー + HITL | 3〜4 週 | Phase 1（2 と並行可） |
| 4 | 可観測性 + 評価 | 1〜2 週 | Phase 1（OTel は 1 に前倒し） |
| 5 | セキュリティ | 1〜2 週 | Phase 3 |

### Traceability Matrix（要件 → 出典）

| Req | 主要出典 |
|-----|----------|
| 1 モノレポ+Agent | 計画書 Phase 1、Pydantic AI 対応表（deps/Agent）、env 駆動プロバイダ |
| 2 RAG | 計画書 Phase 2、sandbox `patterns/rag`（`RetrievedChunk`/`Citation`） |
| 3 ワークフロー/HITL | 計画書 Phase 3、sandbox `orchestrator-workers` / `deep-research` / `sse` |
| 4 可観測性+評価 | 計画書 Phase 4、sandbox `patterns/eval-graders`（`GradeReport`） |
| 5 セキュリティ | 計画書 Phase 5、sandbox `SECURITY-NOTES.md`（OWASP Agentic Top10） |

### Sandbox パターン対応（`patterns/` → Phase / 要件）

| sandbox パターン | 対応 Phase / 要件 |
|------------------|-------------------|
| 単一エージェント（構造化出力・型付きツール） | Phase 1 / R1（`createChatAgent` + Zod 出力） |
| `routing` | Phase 3 / R3.3（supervisor の分類→分配） |
| `orchestrator-workers` | Phase 3 / R3.3（動的計画→並列→統合） |
| `parallelization` | Phase 3 / R3.3（fan-out する専門エージェント） |
| `evaluator-optimizer` | Phase 4 / R4.4–4.5（生成⇄評価ループ） |
| `autonomous-agent` | Phase 1/3（ツールループ + `stopWhen` ガードレール） |
| `rag`（応用） | Phase 2 / R2 |
| `sse`（応用） | Phase 3 / R3.6（進捗イベント配信） |
| `deep-research`（応用） | Phase 3 / R3.3（有界並列マルチエージェント調査） |
| `eval-graders`（横断契約） | Phase 4 / R4.5（outcome+behavior 多軸採点） |

## Out of Scope / Future Work

- Python 側 sandbox 実装そのものの移植（本リポジトリは TypeScript / AI SDK 7 が正）。sandbox は設計思想・パターン契約の参照元に留める。
- MCP クライアント統合（AI SDK MCP、必要時に別 spec）。
- Cohere Rerank 等の再ランク（Req 2.7 の後続）。
- 本番向け課金最適化・マルチテナント・SLA 設計。
- Vision / マルチモーダル入力（現行スコープはテキストチャット + RAG + ワークフロー）。

---

_Initialized: 2026-07-04T20:22:30+0900_
_Requirements generated: 2026-07-04T20:28:00+0900_
