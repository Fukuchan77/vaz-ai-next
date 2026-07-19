# 002-pydantic-enhance — Technical Plan

承認済み要件（WHAT）を設計（HOW）へ翻訳する。実装コードは含まない。
`spec.md` / `research.md`（ADR-A〜E）/ `gap-analysis.md` に準拠する。
散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

## Summary

既存の VAZ スタック（env 駆動プロバイダ / Zod 境界 / 品質ゲート / 単一ライター ingest /
sticky taint 防御）を**保存したまま**、6 要件を **Phase A〜E の独立着地トラック**として
段階的に載せる。アーキテクチャは spec Clarifications で確定済み — **本線（チャット/ジョブ）は
VAZ のまま強化（RV 系）し、Python は「データ・評価処理層」限定のステートレスサイドカー
`services/agent`（FastAPI + Pydantic AI + LlamaIndex）として `@vaz/*` 依存グラフの外に追加**する
（選択肢 B）。設計の核は 5 つの ADR に集約される:

- **ADR-A** — トークン予算は `stopWhen` 配列（`isStepCount` OR 予算述語）+ フック外
  純粋関数 `deriveStopReason` による `stop_reason` 導出（v7 の `StopCondition` は累積 usage を
  引数に渡さないため）。
- **ADR-B** — 契約ドリフトテストは **TS 側 vitest** に置き既存 CI で常時実行。
- **ADR-C** — Python サービスは **uv ローカル起動を既定**、compose 統合は保留（NFR-1 独立着地）。
- **ADR-D** — run-metrics 監査は `AuditSink` の **optional `recordRun`** で migration 回避。
- **ADR-E** — `JobEvent` 拡張は `completion` バリアントの **optional `metrics`**（SSE wire 後方互換）。

各 Phase は独立検証可能・後方互換（NFR-1/NFR-6）。境界は「新設サイドカー」と「本線拡張」の
2 面で、言語境界のスキーマ正本は **新設 HTTP 境界のみ Pydantic**（既存 Zod 契約は不変・ADR-B）。

## Architecture Overview

```mermaid
flowchart TD
  subgraph apps
    WEB["apps/web<br/>Next.js 16（UI + thin route adapters）"]
    WK["apps/worker<br/>Inngest durable runner"]
  end
  subgraph packages
    AG["@vaz/agents<br/>CHAT_SYSTEM_PROMPT / stop_reason / doc-gen verifier"]
    SC["@vaz/schemas<br/>Zod 正本 + generated/agent-service.ts（PL-1）"]
    RAG["@vaz/rag<br/>ingest --via-parser / locator（PL-2）"]
    EV["@vaz/evals<br/>golden set ≥20 / tier2 / PR ゲート（RV-4）"]
    CF["@vaz/config<br/>resolveModel（不変）"]
  end
  subgraph services
    PY["services/agent<br/>FastAPI + Pydantic AI + LlamaIndex<br/>（ステートレス・DB 非接触）"]
  end
  DB[("PostgreSQL + pgvector<br/>chunk.locator 追加（Phase D）")]
  CI["CI<br/>eval-nightly.yml（既存）+ PR ゲート（新設）"]

  WEB -->|"POST /api/chat"| AG
  AG --> CF
  AG --> SC
  EV -->|"tier2: POST /eval/faithfulness,/eval/relevancy"| PY
  RAG -->|"ingest --via-parser: POST /parse"| PY
  RAG --> DB
  AG -->|"doc-gen verifier（opt-in）: /eval/*"| PY
  PY -. OpenAPI 3.1 .-> SC
  SC -->|"openapi-typescript（committed）"| SC
  CI --> EV
  WK --> AG
```

主要な流れ:
- **Phase A（本線 TS 強化）**: `@vaz/agents` の `prompt.ts` に `CHAT_SYSTEM_PROMPT` を定数化し
  `buildStreamTextOptions` が `system` として渡す。`stopWhen` を配列化して累積トークン予算述語を
  OR 併置、`onEnd` で `deriveStopReason` を導出しテレメトリ + `deps.audit.recordRun` へ記録
  （ADR-A/D）。`prepareStep` に履歴窓化シームを opt-in で足す（未設定時 byte 等価）。
- **Phase B（評価サイドカー）**: `services/agent` を新設。LlamaIndex の低レベル `evaluate` を
  `POST /eval/faithfulness`・`/eval/relevancy` として公開。ステートレス・ネットワークゼロ試験
  （`httpx.ASGITransport`）。
- **Phase C（境界契約）**: FastAPI OpenAPI → `openapi-typescript` → `packages/schemas/src/generated/
  agent-service.ts`（コミット）+ 薄い手書き Zod。ドリフトは TS 側 vitest 1 点照合（ADR-B）。
- **Phase D（取り込み強化）**: `POST /parse`（Docling `HybridChunker`、LlamaParse opt-in）。
  `retrievedChunkSchema` + chunk テーブルに optional `locator` を追加。ingest CLI `--via-parser` が
  返却チャンクを**既存 embed+upsert 経路へ供給**（単一ライター不変）。
- **Phase E（評価還流・ゲート・文書）**: golden set ≥20、nightly tier2 追加、PR ゲート 3 指標、
  doc-gen 検証ステップ（Doer-Verifier）、`docs/agentops.md`、MCP ADR。

## Components

### services/agent （Python 評価/解析サイドカー / 新設 / Phase B・D）

- **Responsibility**: LlamaIndex の RAG 評価（Faithfulness/Relevancy）と Docling の構造保持
  パーシングを HTTP で提供する**ステートレス**サービス。呼び出し元は nightly runner と
  ingest CLI（内部ネットワーク + S2S トークン）。
- **Public interface**: `POST /eval/faithfulness`・`POST /eval/relevancy`（`{question, contexts,
  answer}` → `{score, verdict, judge_model, usage}`、Req 2.2）; `POST /parse`（document →
  `{source, locator, ordinal, text}[]`、Docling 既定・LlamaParse opt-in、Req 4.1/4.2）;
  `GET /openapi.json`（OpenAPI 3.1、Phase C の型生成元）; `GET /healthz`。
- **Owns**: FastAPI ルーティング、Pydantic 境界モデル（新 HTTP 境界の**正本**、Req 3.1）、
  judge LLM 解決（`config.py` の env + in-file allowlist、Req 2.6/NFR-2）、fail-soft OTel
  （`gen_ai.*` + `caseId`/`jobId`、Req 2.7）、uv-lock + pip-audit（NFR-5）。
- **Does NOT own**: DB/Redis/ファイルシステム永続化（ステートレス、Req 2.3/単一ライター）、
  embedding 生成・pgvector 書き込み（`@vaz/rag` の専管）、監査の永続化（第 2 発火点を作らない、
  NFR-3 — 監査は TS 呼び出し側の `deps.audit`）、既存 Zod 契約の生成（境界単位の正本のみ）。
- **Requirements**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 4.1, 4.2, NFR-2, NFR-3, NFR-4, NFR-5

### @vaz/agents （本線エージェント強化 / Phase A・E）

- **Responsibility**: チャットエージェントに system プロンプト・トークン予算・停止理由の
  権威側宣言と監査を足し（RV-1/2/3）、supervisor の doc-gen に opt-in の検証ステップを足す（RV-7）。
- **Public interface**: `CHAT_SYSTEM_PROMPT`（`prompt.ts`、role/tone・tool-usage・citation format・
  区切りコンテキストは参照データという権威側宣言、Req 1.1）; `buildStreamTextOptions` が `system` +
  `stopWhen: [isStepCount(MAX_STEPS), budgetPredicate]` + `onEnd`（Req 1.2/1.3/1.4）;
  純粋関数 `deriveStopReason({ finishReason, totalUsage, steps, budget, maxSteps })`（ADR-A、
  `runStopReasonSchema` を返す）; `buildPrepareStep` に optional 履歴窓化引数（Req 1.7、未指定時 byte 等価）;
  supervisor doc-gen の verifier 呼び出し（成果物 + 受入基準のみ、`/eval/*` opt-in、Req 5.5/5.6/5.7）。
- **Owns**: system プロンプト本文、停止理由導出ロジック、run-finish 監査の発火点（`onEnd` →
  `deps.audit.recordRun`、ADR-D）、Doer-Verifier の会話履歴遮断（Req 5.6）。
- **Does NOT own**: `stop_reason` 語彙・run-metrics スキーマの**定義**（`@vaz/schemas`）、判定モデル
  呼び出しの実体（`services/agent`）、監査の永続化実装（web/worker の sink）、閾値 env の検証
  （`@vaz/schemas/env`）。
- **Requirements**: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 5.5, 5.6, 5.7

### @vaz/schemas （契約の単一正本 + 生成型 / Phase A・C・D）

- **Responsibility**: 本線の新契約（stop_reason 語彙 / run-metrics / locator）を Zod で単一
  正本化し、言語境界の**生成 TS 型 + 薄い Zod ラッパ**を保持する（NFR-6）。
- **Public interface**: `runStopReasonSchema = z.enum(["natural","step-cap","budget-exceeded","error"])`
  （ADR-A、Req 1.4）; `runMetricsSchema`（`stopReason` + token 数 + `stepCount`、Req 1.5）;
  `env.ts` に `CHAT_TOKEN_BUDGET`（Zod default、Req 1.3）; `workflows.ts` の `completion` に
  `metrics: runMetricsSchema.optional()`（ADR-E、Req 1.5/5.7/NFR-6）; `retrievedChunkSchema` に
  optional `locator`（Req 4.3）; `generated/agent-service.ts`（openapi-typescript 生成・コミット、
  Req 3.2）+ 薄い手書き Zod（Req 3.3）; `deps.ts` の `AuditSink` に optional `recordRun`（ADR-D）。
- **Owns**: 全 Zod スキーマ定義と推論型、生成 TS 型の格納（no build step・コミット運用）。
- **Does NOT own**: OpenAPI の**生成元**（`services/agent` の Pydantic が正本、Req 3.1）、
  ランタイム実装、監査の永続化。既存 Zod（`chatRequestSchema`/`jobEvent`/rag/env）の意味論は不変。
- **Requirements**: 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 4.3, NFR-6

### @vaz/rag （取り込み強化 / Phase D）

- **Responsibility**: 構造保持パーシングを ingest 経路に接続する。`--via-parser` で `/parse` の
  返却チャンクを**既存 embed+upsert 経路**へ供給し、locator を永続化する。単一ライター不変。
- **Public interface**: `chunk` テーブルに nullable `locator` 列（Drizzle + drizzle-zod 単一ソース、
  migration 同梱、Req 4.3）; ingest CLI `--via-parser`（`AGENT_SERVICE_URL` へ POST、返却チャンクを
  embed+upsert、Req 4.4）; サービス到達不可時の fail-loud（Req 4.6）。
- **Owns**: chunk 永続スキーマ + migration、`--via-parser` 経路の HTTP クライアント配線、
  provenance 不変ガード（`assertNoProviderMixing` は無傷）。
- **Does NOT own**: パーシング実体（`services/agent`）、embedding プロバイダ解決（`@vaz/config`）、
  locator の型定義（`@vaz/schemas/rag`）、既定（非 parser）ingest 経路の挙動（byte 互換で不変）。
- **Requirements**: 4.3, 4.4, 4.5, 4.6

### @vaz/evals （評価還流と CI ゲート / Phase E）

- **Responsibility**: golden set を ≥20 件へ拡充し、nightly に tier2（忠実性/関連性）を足し、
  PR ゲート 3 指標を既存 `eval-nightly.yml` 機構上に構築する（RV-4/PL-3）。
- **Public interface**: `GOLDEN_SET` を ≥20 件へ（audit log 由来・R4.7 匿名化、Req 5.1）;
  `runNightlyEval` に tier2 ステージ（`/eval/*` をケース毎、未設定時 skip、Req 5.2）;
  PR ゲート算出（pass-rate delta / over-under-trigger balance / per-case cost・latency、Req 5.3）;
  report-only 半制御（<20 件は非ブロック、Req 5.4）; `packages/evals/README.md` に出所手順（Req 5.1）。
- **Owns**: golden set、tier2 ステージ配線、PR ゲート指標算出、baseline 保持。
- **Does NOT own**: 評価器実体（`services/agent`）、CI ワークフロー YAML の**トリガー定義**
  （`.github/workflows/`）、忠実性/関連性スコアの計算（judge は Python 側）。
- **Requirements**: 5.1, 5.2, 5.3, 5.4

### CI / Governance docs （横断 / Phase B・E・NFR-2）

- **Responsibility**: 品質ゲートを Python トラック非依存に保ったまま拡張し（NFR-1）、運用文書を固定する。
- **Public interface**: `mise.toml` の `py:check`（uv sync + ruff + pyright + pytest、`check` 非依存、
  Req 2.5）+ `openapi:gen`（再生成 mise タスク、Req 3.5）; `scripts/forbid-model-ids.sh` を
  `services/**/*.py` へ拡張 + `config.py` carve-out（補正 1、NFR-2）; `.github/workflows/` に PR ゲート
  ワークフロー新設 + nightly への tier2 統合（補正 2、Req 5.2/5.3）; `docs/context-budget.md`（Req 1.7）;
  `docs/agentops.md`（3 本柱写像、Req 6.1）; `docs/adr/*-mcp-position.md`（MCP ADR、Req 6.2/6.3）;
  CLAUDE.md から文書へ到達可能に（Req 6.1）。
- **Owns**: ゲート配線、grep スキャン範囲、運用文書、CLAUDE.md の到達リンク。
- **Does NOT own**: 各パッケージ/サービスの機能実装。
- **Requirements**: 1.7, 2.5, 3.5, 5.2, 5.3, 6.1, 6.2, 6.3, NFR-1, NFR-2

## Data Model

Phase D で `chunk` テーブルに 1 列を追加する（他フェーズは DB 不変）。

| Entity | Field | Type | Notes |
|--------|-------|------|-------|
| Chunk | locator | text（**nullable**） | page→section→char 規約（sandbox ADR-4 由来）。既存テキスト ingest は値未書き込み（NULL）で byte 互換（Req 4.3）。drizzle-zod の insert/select schema に列追加で自動反映（手書き禁止）。`EMBEDDING_DIM=768` と `assertNoProviderMixing` は不変（locator は provenance と無関係）。 |

run-metrics は**永続テーブルを増やさない**（ADR-D）: `deps.audit.recordRun` は既存 `auditLog` 行へ
センチネル `tool:"__chat_run__"` + 安全集約 JSON（`stopReason`/token 数、raw 本文なし）として書く。
Phase A では DDL migration 不要。

## Interfaces / Contracts

**新設 HTTP 境界（Pydantic 正本 / Phase B・C・D）**:

- `POST /eval/faithfulness` — body: `{question, contexts: string[], answer}`; res: `{score: float,
  verdict: bool, judge_model: string, usage}`（LlamaIndex 低レベル `evaluate`、Req 2.2）。
- `POST /eval/relevancy` — 同上シグネチャ（`query`+`response`+`contexts` を要する、Req 2.2）。
- `POST /parse` — body: document（PDF 以上）+ opt `use_llamaparse`; res: `{source, locator, ordinal,
  text}[]`（Docling `HybridChunker` 既定、Req 4.1/4.2）。
- OpenAPI 3.1（`/openapi.json`）→ `openapi-typescript` → `packages/schemas/src/generated/
  agent-service.ts`（コミット、Req 3.2）; 薄い手書き Zod が生成型に conform（Req 3.3）。

**本線契約拡張（Zod 正本 / 後方互換 / Phase A・E）**:

- `runStopReasonSchema`（閉じた語彙、ADR-A）+ `runMetricsSchema`（Req 1.4/1.5）。
- `JobEvent.completion.metrics`（optional、SSE wire 後方互換、ADR-E/NFR-6）。
- `env.ts`: `CHAT_TOKEN_BUDGET`（Zod default、保守的既定 — 例 200_000、Req 1.3）。
- `AuditSink.recordRun?`（optional、未実装 sink は no-op、ADR-D/R4.7）。

**CLI / タスク**:

- `node packages/rag/src/ingest/index.ts --via-parser <path>` — `/parse` 経由 ingest（Req 4.4）。
- `mise run py:check` — Python トラック（`check` 非依存、Req 2.5）。
- `mise run openapi:gen` — OpenAPI → 生成 TS 型の再生成（Req 3.5）。

## File Structure Plan

MANDATORY。作成/変更する全ファイルと 1 文責務。ここに無いパスは tasks.md の `_Boundary:_`
対象にできない。**Phase 列**が独立着地（NFR-1）を担保する。

### Phase A — 本線 TS 強化（Req 1 / NFR-6）

| File | Create/Modify | Phase | Responsibility |
|------|---------------|-------|----------------|
| `packages/agents/src/prompt.ts` | Modify | A | `CHAT_SYSTEM_PROMPT` 定数を追加（role/tone・tool-usage・citation format・権威側宣言、既存デリミタ定数を参照、Req 1.1） |
| `packages/schemas/src/env.ts` | Modify | A | `CHAT_TOKEN_BUDGET`（Zod default、Req 1.3）を追加 |
| `packages/schemas/src/run-metrics.ts` | Create | A | `runStopReasonSchema`（閉じた語彙）+ `runMetricsSchema`（ADR-A/E、Req 1.4/1.5） |
| `packages/schemas/src/deps.ts` | Modify | A | `AuditSink` に optional `recordRun?(entry)` + `RunAuditEntry` 型（ADR-D、Req 1.4） |
| `packages/schemas/src/workflows.ts` | Modify | A | `completion` バリアントに `metrics: runMetricsSchema.optional()`（ADR-E、Req 1.5/NFR-6） |
| `packages/agents/src/stop-reason.ts` | Create | A | 純粋関数 `deriveStopReason(...)`（フック外導出、ADR-A、Req 1.4） |
| `packages/agents/src/chat-agent.ts` | Modify | A | `buildStreamTextOptions` に `system` + `stopWhen` 配列（予算述語）+ `onEnd`（`deriveStopReason`→telemetry + `recordRun`）; `buildPrepareStep` に optional 履歴窓化引数（Req 1.2/1.3/1.4/1.7） |
| `packages/agents/tests/chat-agent.spec.ts` | Modify | A | 3 停止経路（budget/step-cap/natural）を `MockLanguageModelV4` で検証 + system 内容 assert（Req 1.2/1.6） |
| `packages/agents/tests/stop-reason.spec.ts` | Create | A | `deriveStopReason` の決定論単体テスト（優先順 error→budget→step-cap→natural、Req 1.4/1.6） |
| `docs/context-budget.md` | Create | A | 現行コンテキスト方針 + 段階的 compaction + `prepareStep` 窓化シーム（Req 1.7） |

### Phase B — Python 評価サイドカー（Req 2 / NFR-2,3,4,5）

| File | Create/Modify | Phase | Responsibility |
|------|---------------|-------|----------------|
| `services/agent/pyproject.toml` | Create | B | uv-managed プロジェクト定義（FastAPI/Pydantic AI/LlamaIndex/pyright strict、NFR-5） |
| `services/agent/uv.lock` | Create | B | uv ロックファイル（供給網監査、NFR-5） |
| `services/agent/app/__init__.py` | Create | B | パッケージマーカー |
| `services/agent/app/config.py` | Create | B | env 検証（pydantic-settings）+ judge model in-file allowlist（NFR-2 carve-out 対象、Req 2.6） |
| `services/agent/app/main.py` | Create | B | FastAPI app 構築 + ルータ登録 + fail-soft OTel（`gen_ai.*`、Req 2.7） |
| `services/agent/app/schemas.py` | Create | B | Pydantic 境界モデル（eval I/O、新 HTTP 境界の正本、Req 3.1） |
| `services/agent/app/routes/eval.py` | Create | B | `/eval/faithfulness`・`/eval/relevancy`（LlamaIndex 低レベル `evaluate`、Req 2.2） |
| `services/agent/app/eval/llama.py` | Create | B | judge 注入した `FaithfulnessEvaluator`/`RelevancyEvaluator` ラッパ（Req 2.2/2.6） |
| `services/agent/app/telemetry.py` | Create | B | fail-soft OTel 初期化 + サニタイズ済みログ（NFR-3） |
| `services/agent/tests/conftest.py` | Create | B | 決定論 judge フェイク + `httpx.ASGITransport`（ネットワークゼロ、Req 2.4） |
| `services/agent/tests/test_eval.py` | Create | B | `/eval/*` の契約 + verdict/score 写像テスト（Req 2.2/2.4） |
| `services/agent/tests/test_config.py` | Create | B | env 検証 + judge allowlist（Req 2.6） |
| `services/agent/README.md` | Create | B | 起動（`uv run`）・env・S2S トークン方針（ADR-C、NFR-4） |
| `scripts/forbid-model-ids.sh` | Modify | B | 走査を `services/**/*.py` へ拡張 + `config.py` carve-out（補正 1、NFR-2） |
| `mise.toml` | Modify | B | `py:check`（uv sync + ruff + pyright + pytest、`check` 非依存、Req 2.5） |

### Phase C — 境界契約の単一情報源（Req 3）

| File | Create/Modify | Phase | Responsibility |
|------|---------------|-------|----------------|
| `packages/schemas/src/generated/agent-service.ts` | Create | C | OpenAPI → `openapi-typescript` 生成型（コミット・no build step、Req 3.2） |
| `packages/schemas/src/generated/openapi.snapshot.json` | Create | C | コミット済み OpenAPI スナップショット（ドリフト照合の基準、ADR-B、Req 3.4） |
| `packages/schemas/src/agent-service.ts` | Create | C | 薄い手書き Zod（生成型に conform、Req 3.3） |
| `packages/schemas/tests/contract-drift.spec.ts` | Create | C | 1 点照合ドリフトテスト（スナップショット↔生成型↔薄い Zod、ADR-B、Req 3.4） |
| `mise.toml` | Modify | C | `openapi:gen`（OpenAPI 出力 → 生成型再生成、Req 3.5） |
| `pnpm-workspace.yaml` | Modify | C | `openapi-typescript` の `allowBuilds` 監査エントリ（install script 有無、`minimumReleaseAge`、Req 3.2） |
| `package.json`（root or `@vaz/schemas`） | Modify | C | `openapi-typescript` を devDependency 宣言（Req 3.2） |

### Phase D — 取り込み強化 / 構造保持パーシング（Req 4）

| File | Create/Modify | Phase | Responsibility |
|------|---------------|-------|----------------|
| `services/agent/app/schemas.py` | Modify | D | `/parse` の Pydantic I/O（`{source, locator, ordinal, text}`、Req 4.1） |
| `services/agent/app/routes/parse.py` | Create | D | `/parse`（Docling `HybridChunker` 既定、LlamaParse opt-in、Req 4.1/4.2） |
| `services/agent/app/parse/docling.py` | Create | D | Docling 変換 + `locator`（page→section→char）組立て（Req 4.1） |
| `services/agent/tests/test_parse.py` | Create | D | チャンク→契約写像を決定論フェイクで検証（実変換は E2E、Req 4.1/2.4） |
| `packages/rag/src/db/schema.ts` | Modify | D | `chunk` テーブルに nullable `locator` 列（drizzle-zod 自動反映、Req 4.3） |
| `packages/rag/drizzle/NNNN_add_locator.sql` | Create | D | locator 列追加 migration（既存行 NULL、byte 互換、Req 4.3） |
| `packages/schemas/src/rag.ts` | Modify | D | `retrievedChunkSchema` に optional `locator`（Req 4.3） |
| `packages/rag/src/ingest/index.ts` | Modify | D | `--via-parser` フラグ経路（`/parse`→既存 embed+upsert、fail-loud、単一ライター不変、Req 4.4/4.6） |
| `packages/rag/tests/via-parser.spec.ts` | Create | D | `--via-parser` の provenance 不変 + fail-loud + 既定経路 byte 互換（Req 4.4/4.6） |
| `apps/web/tests/e2e/locator-citation.spec.ts` | Create | D | PDF ingest→チャット引用に locator が出る E2E（ローカルスタック、Req 4.5） |

### Phase E — 評価還流・ゲート・文書（Req 5, 6）

| File | Create/Modify | Phase | Responsibility |
|------|---------------|-------|----------------|
| `packages/evals/src/nightly.ts` | Modify | E | `GOLDEN_SET` を ≥20 件へ + tier2 ステージ（`/eval/*`、未設定時 skip、Req 5.1/5.2） |
| `packages/evals/src/tier2.ts` | Create | E | 忠実性/関連性クライアント（`/eval/*` 呼び出し + per-case スコア、Req 5.2） |
| `packages/evals/src/pr-gate.ts` | Create | E | 3 指標算出（pass-rate delta / trigger balance / cost・latency、report-only 半制御、Req 5.3/5.4） |
| `packages/evals/README.md` | Create | E | golden set 出所・R4.7 匿名化手順（Req 5.1） |
| `packages/evals/tests/pr-gate.spec.ts` | Create | E | 3 指標算出 + report-only 閾値ロジック（Req 5.3/5.4） |
| `packages/agents/src/supervisor.ts` | Modify | E | doc-gen に optional 検証ステップ（機械チェック→`/eval/*` opt-in、成果物+基準のみ、失敗時 JobEvent、Req 5.5/5.6/5.7） |
| `packages/agents/tests/supervisor-verify.spec.ts` | Create | E | Doer-Verifier 分離 + 検証失敗時の閉じた語彙 JobEvent（Req 5.5/5.6/5.7） |
| `.github/workflows/eval-pr.yml` | Create | E | PR ゲートワークフロー（既存 secrets ゲート機構を再利用、Req 5.3） |
| `.github/workflows/eval-nightly.yml` | Modify | E | tier2 ステージを既存 nightly に追加（未設定時 skip、Req 5.2） |
| `docs/agentops.md` | Create | E | AgentOps 3 本柱をリポジトリ実装へ写像（未実装は要件 ID 参照、Req 6.1） |
| `docs/adr/0001-mcp-position.md` | Create | E | MCP 非採用理由 + 採用条件 + 設計原則 + 脅威モデル参照（Req 6.2/6.3） |
| `CLAUDE.md` | Modify | E | `docs/agentops.md` と MCP ADR への到達リンク（Req 6.1） |

## Error Handling & Edge Cases

- 予算超過で停止しても `finishReason` に固有値は出ない → `deriveStopReason` がフック外で
  `{ finishReason, totalUsage, steps, budget, maxSteps }` から導出（ADR-A、Req 1.4）。
- 予算はステップ完了粒度でしか止まらない → ハード上限でなく「次ステップ抑止」閾値と位置づけ、
  `MAX_STEPS` を安全網として併存（ADR-A リスク緩和）。
- `services/agent` 未設定 → nightly tier2 は **skip（fail ではない）**（Req 5.2）; doc-gen verifier は
  未設定時 no-op で既定挙動不変（Req 5.5）; `--via-parser` は **fail-loud**、既定 ingest は不変（Req 4.6）。
- OpenAPI と生成型/薄い Zod がズレる → ドリフト vitest が 1 点で落ちる（ADR-B、Req 3.4）。
- locator 列追加は migration を伴う → 既存行 NULL 既定で後方互換、Phase A〜C は DB 不変（Req 4.3）。
- golden set <20 件 → PR ゲートは report-only（非ブロック）、閾値ブロックは 5.1 達成後（Req 5.4）。
- Python 側で raw question/answer/context をログに出さない → サニタイズ識別子のみ（NFR-3）。
- モデル ID を `services/**` に直書き（`config.py` 除く）→ `forbid-model-ids.sh` 拡張で lint 失敗（NFR-2）。
- system プロンプト導入で eval verdict が変わりうる → マージ前に tier3 nightly の before/after を記録
  （Req 1.8、Req 5 還流ループ初回行使）。
- Docling のモデル DL → 単体はチャンク→契約写像を決定論フェイクで検証、実変換は E2E/手動レーン（調査 4）。

## Constitution Compliance

| Principle | Status | Notes |
|-----------|--------|-------|
| 1. Validate at Every Boundary | ✅ | 新 HTTP 境界は Pydantic 正本、TS 側は生成型 + 薄い Zod でドリフト検証（ADR-B）。既存 Zod 契約は不変。 |
| 2. Test-First Discipline | ✅ | `deriveStopReason`/3 停止経路/契約ドリフト/via-parser/PR ゲートは先行失敗テスト。Python 単体はネットワークゼロ（Req 2.4）。 |
| 3. Current-API Fidelity | ✅ | v7 `stopWhen` 配列 / `onEnd`(`onFinish` alias) / `totalUsage` / `prepareStep` は同梱 docs で実地確認（research §1/§2、`ai@7.0.14`）。 |
| 4. Provider-Agnostic & Local-First | ✅ | judge/embedding は env 駆動、LlamaParse は opt-in（既定 Docling ローカル、Req 4.2）。 |
| 5. Quality Gates Non-Negotiable | ✅ | `py:check` は `check` 非依存で TS ゲートは Python 無しでも緑（Req 2.5/NFR-1）。coverage/lint/typecheck 維持。 |
| Supply chain | ✅ | `openapi-typescript` は `allowBuilds` + `minimumReleaseAge` 監査、Python は uv-lock + pip-audit（Req 3.2/NFR-5）。 |
| Secrets | ✅ | judge/LlamaParse キーは env、S2S トークンは内部ネットワーク、ブラウザ非公開（NFR-4）。 |
| Single-writer / Privacy | ✅ | pgvector 書き込みは `@vaz/rag` の 1 箇所、監査は TS 側 `deps.audit` の単一発火点（単一ライター / NFR-3）。 |

CRITICAL 違反なし。全 MUST 原則充足。

## Requirements Traceability

| Requirement ID | Component(s) |
|----------------|--------------|
| 1.1 | @vaz/agents (prompt.ts) |
| 1.2 | @vaz/agents (chat-agent.ts), @vaz/agents (tests) |
| 1.3 | @vaz/agents (chat-agent.ts), @vaz/schemas (env.ts) |
| 1.4 | @vaz/agents (stop-reason.ts, chat-agent.ts onEnd), @vaz/schemas (run-metrics.ts, deps.ts) |
| 1.5 | @vaz/schemas (run-metrics.ts, workflows.ts) |
| 1.6 | @vaz/agents (tests) |
| 1.7 | @vaz/agents (chat-agent.ts prepareStep), CI/docs (context-budget.md) |
| 1.8 | @vaz/evals (nightly before/after), CI/docs（プロセス） |
| 2.1 | services/agent |
| 2.2 | services/agent (routes/eval.py, eval/llama.py) |
| 2.3 | services/agent |
| 2.4 | services/agent (tests) |
| 2.5 | CI/Governance (mise.toml py:check) |
| 2.6 | services/agent (config.py), CI/Governance (forbid-model-ids.sh) |
| 2.7 | services/agent (telemetry.py) |
| 3.1 | services/agent (schemas.py), @vaz/schemas |
| 3.2 | @vaz/schemas (generated/), pnpm-workspace.yaml |
| 3.3 | @vaz/schemas (agent-service.ts) |
| 3.4 | @vaz/schemas (contract-drift.spec.ts) |
| 3.5 | CI/Governance (mise.toml openapi:gen) |
| 4.1 | services/agent (routes/parse.py, parse/docling.py) |
| 4.2 | services/agent (parse/docling.py) |
| 4.3 | @vaz/rag (db/schema.ts, migration), @vaz/schemas (rag.ts) |
| 4.4 | @vaz/rag (ingest/index.ts) |
| 4.5 | apps/web (E2E) |
| 4.6 | @vaz/rag (ingest/index.ts) |
| 5.1 | @vaz/evals (nightly.ts, README.md) |
| 5.2 | @vaz/evals (tier2.ts, nightly.ts), CI (eval-nightly.yml) |
| 5.3 | @vaz/evals (pr-gate.ts), CI (eval-pr.yml) |
| 5.4 | @vaz/evals (pr-gate.ts) |
| 5.5 | @vaz/agents (supervisor.ts) |
| 5.6 | @vaz/agents (supervisor.ts) |
| 5.7 | @vaz/agents (supervisor.ts), @vaz/schemas (workflows.ts) |
| 6.1 | CI/Governance (docs/agentops.md, CLAUDE.md) |
| 6.2 | CI/Governance (docs/adr/0001-mcp-position.md) |
| 6.3 | CI/Governance (docs/adr/0001-mcp-position.md) |
| NFR-1 | CI/Governance（全 Phase 独立着地） |
| NFR-2 | CI/Governance (forbid-model-ids.sh), services/agent (config.py) |
| NFR-3 | services/agent (telemetry.py) |
| NFR-4 | services/agent (README.md, config.py) |
| NFR-5 | services/agent (pyproject.toml, uv.lock) |
| NFR-6 | @vaz/schemas (workflows.ts, run-metrics.ts) |

---

_Plan generated: 2026-07-19_
