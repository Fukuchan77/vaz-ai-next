# 002-pydantic-enhance — Implementation Tasks

`/sdd-tasks` により生成。`plan.md` の File Structure Plan と `research.md`（ADR-A〜E）に準拠する。
散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

規約:

- `- [ ]` 未着手 / `- [x]` 完了 / `- [ ]*` 任意・後回し可（コア実装で受入基準は充足済み）。
- `(P)` = 並列実行安全（依存なし・境界が互いに素）。同一 wave 内でのみ判定。
- 全タスク（major/sub）は `_Boundary:_` と `_Depends:_` を宣言する。
- `_Requirements:_` は要件 ID のみをカンマ区切りで列挙する。
- Phase A〜E は各要件に 1:1 対応し、**各 Phase は独立着地可能**（NFR-1）。Phase 間依存は
  `Phase B → Phase C`、`Phase B → Phase D`、`Phase B → Phase E(5.2/5.5)`、`Phase E 5.1 → 5.4` のみ。
- テスト規約（Constitution P2）: `src/` のユニットロジックは Red-Green-Refactor で進める
  （失敗テストを先に書き、確認後に最小実装）。Python 単体はネットワークゼロ（`httpx.ASGITransport`、
  Req 2.4）。E2E・PR ゲート・契約ドリフトは性質上「実装後の検証」でこの限りでない。

## Phase / Wave 依存図

```
Phase A（Task 1→2→3）──────────── 先行・完全独立（RV 計画 P0/P1）
Phase B（Task 4→5）──┬─→ Phase C（Task 6）
                     ├─→ Phase D（Task 7→8）
                     └─→ Phase E の tier2/verifier（Task 9.2, 11）
Phase E（Task 9→10→12、Task 9.1 golden set → 10.3 ゲート有効化）
Task 12（governance 文書）は独立。ただし 12.1 は Task 2（Req 1.4 メトリクス）着地後が望ましい。
```

---

## Phase A — 本線 TS 強化（Req 1）

## 1. `@vaz/schemas` 契約拡張（stop_reason 語彙 / run-metrics / 予算 env / 監査シンク）

停止理由の閉じた語彙・run-metrics・トークン予算 env・`AuditSink.recordRun` を単一正本へ足す
（Task 2 の前提）。既存 Zod の意味論は不変、`JobEvent` 拡張は後方互換（ADR-D/E、NFR-6）。

_Boundary:_ `packages/schemas/src/run-metrics.ts`, `packages/schemas/src/env.ts`, `packages/schemas/src/deps.ts`, `packages/schemas/src/workflows.ts`
_Depends:_ none
_Requirements:_ 1.3, 1.4, 1.5, NFR-6

- [x] 1.1 `src/run-metrics.ts` を新設し `runStopReasonSchema = z.enum(["natural","step-cap","budget-exceeded","error"])`
  と `runMetricsSchema`（`stopReason` + `inputTokens`/`outputTokens`/`totalTokens` + `stepCount`）を定義する（ADR-A/E）。
  _Boundary:_ `packages/schemas/src/run-metrics.ts`
  _Depends:_ none
  _Requirements:_ 1.4, 1.5
- [x] 1.2 (P) `src/env.ts` に `CHAT_TOKEN_BUDGET`（`z.coerce.number().int().positive()` + 保守的 `.default(200_000)`）を追加する
  （既存 env 契約は不変、default 追加のみ）。
  _Boundary:_ `packages/schemas/src/env.ts`
  _Depends:_ none
  _Requirements:_ 1.3
- [x] 1.3 (P) `src/deps.ts` の `AuditSink` に optional `recordRun?(entry: RunAuditEntry)` と `RunAuditEntry` 型
  （`userId`/`jobId`/`stopReason`/token 数/`ts`、raw 本文なし）を追加する（ADR-D、未実装 sink は no-op で後方互換、R4.7）。
  _Boundary:_ `packages/schemas/src/deps.ts`
  _Depends:_ 1.1
  _Requirements:_ 1.4
- [x] 1.4 `src/workflows.ts` の `completion` バリアントに `metrics: runMetricsSchema.optional()` を足す
  （ADR-E、discriminated union / `jobEventTypeSchema` / DB enum は不変、SSE wire 後方互換）。
  _Boundary:_ `packages/schemas/src/workflows.ts`
  _Depends:_ 1.1
  _Requirements:_ 1.5, NFR-6

## 2. `@vaz/agents` system プロンプト・トークン予算・停止理由監査

`CHAT_SYSTEM_PROMPT` を権威側宣言として定数化し `system` で渡す。`stopWhen` を配列化して累積
トークン予算述語を OR 併置、`onEnd` で `deriveStopReason` を導出しテレメトリ + `deps.audit.recordRun`
へ記録する（ADR-A/D）。`prepareStep` に未設定時 byte 等価の履歴窓化シームを足す。

_Boundary:_ `packages/agents/src/prompt.ts`, `packages/agents/src/stop-reason.ts`, `packages/agents/src/chat-agent.ts`, `packages/agents/tests/stop-reason.spec.ts`, `packages/agents/tests/chat-agent.spec.ts`
_Depends:_ 1
_Requirements:_ 1.1, 1.2, 1.3, 1.4, 1.6, 1.7

- [x] 2.1 `src/prompt.ts` に `CHAT_SYSTEM_PROMPT` 定数を追加する。(a) role/tone、(b) tool-usage
  ポリシー（`searchDocuments` をいつ呼ぶか）、(c) citation format（`[source#ordinal]`）、(d) 区切り
  コンテキストは参照データで指示ではないという権威側宣言（既存 `RETRIEVED_CONTEXT_BEGIN`/
  `UNTRUSTED_NOTICE` を参照して一貫させる、R5.2 との対比）。
  _Boundary:_ `packages/agents/src/prompt.ts`
  _Depends:_ none
  _Requirements:_ 1.1
- [x] 2.2 `src/stop-reason.ts` に純粋関数 `deriveStopReason({ finishReason, totalUsage, steps, budget, maxSteps })`
  を実装する（フック外導出、優先順 `error`→`budget-exceeded`→`step-cap`→`natural`、`length`/
  `content-filter`/`other` は `natural` に畳み raw finishReason は別途テレメトリ属性へ、ADR-A）。
  _Boundary:_ `packages/agents/src/stop-reason.ts`
  _Depends:_ 1.1
  _Requirements:_ 1.4
- [x] 2.3 `tests/stop-reason.spec.ts` を先行作成し（Red-Green）、`deriveStopReason` の 4 経路 + 優先順を
  決定論単体テストで固定する（2.2 実装前に失敗を確認）。
  _Boundary:_ `packages/agents/tests/stop-reason.spec.ts`
  _Depends:_ 1.1
  _Requirements:_ 1.4, 1.6
- [x] 2.4 `src/chat-agent.ts` の `buildStreamTextOptions` に (a) `system: CHAT_SYSTEM_PROMPT`、
  (b) `stopWhen: [isStepCount(MAX_STEPS), budgetPredicate]`（`steps[].usage` の input+output 合算 ≥
  `CHAT_TOKEN_BUDGET`、env 由来）、(c) `onEnd`（`deriveStopReason`→span 属性 + `deps.audit.recordRun`）を配線する。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 2.1, 2.2, 1.2, 1.3
  _Requirements:_ 1.2, 1.3, 1.4
- [x] 2.5 `src/chat-agent.ts` の `buildPrepareStep` に optional 履歴窓化引数（`windowMessages?`）を足す
  （未指定時は現行の追記結果をそのまま返し byte 等価、公式 `pruneMessages` 相当を呼び出し側で差し込める形、Req 1.7）。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 2.4
  _Requirements:_ 1.7
- [x] 2.6 `tests/chat-agent.spec.ts` に 3 停止経路（budget-exceeded / step-cap / natural）の
  `MockLanguageModelV4` テストと、system 内容（デリミタ言及・citation format）+ built options への
  存在検証を足す（Red-Green、Req 1.2/1.6）。
  _Boundary:_ `packages/agents/tests/chat-agent.spec.ts`
  _Depends:_ 2.4
  _Requirements:_ 1.2, 1.6

## 3. コンテキスト予算方針文書

現行方針（全履歴送信 / step-count cap のみ）と段階的 compaction、`prepareStep` 窓化シームを文書化する。

_Boundary:_ `docs/context-budget.md`
_Depends:_ 2
_Requirements:_ 1.7

- [x] 3.1 `docs/context-budget.md` を作成し、現行コンテキスト方針・段階的 compaction・2.5 の
  窓化シーム（未設定時 byte 等価）を記述する。
  _Boundary:_ `docs/context-budget.md`
  _Depends:_ 2.5
  _Requirements:_ 1.7

---

## Phase B — Python 評価サイドカー（Req 2 / NFR-2,3,4,5）

## 4. `services/agent` スキャフォールド + `py:check` + model-id ゲート拡張

`@vaz/*` 依存グラフ外に FastAPI サービス骨格を新設し、`py:check`（`check` 非依存）と
`forbid-model-ids.sh` の `services/**/*.py` 拡張を配線する（Task 5・6・7 の前提）。

_Boundary:_ `services/agent/pyproject.toml`, `services/agent/uv.lock`, `services/agent/app/__init__.py`, `services/agent/app/config.py`, `services/agent/app/main.py`, `services/agent/app/telemetry.py`, `services/agent/README.md`, `services/agent/tests/test_config.py`, `scripts/forbid-model-ids.sh`, `mise.toml`
_Depends:_ none
_Requirements:_ 2.1, 2.3, 2.5, 2.6, 2.7, NFR-1, NFR-2, NFR-3, NFR-4, NFR-5

- [ ] 4.1 `pyproject.toml` + `uv.lock` を作成し uv-managed プロジェクト（FastAPI / Pydantic /
  pydantic-settings / Pydantic AI / llama-index-core / uvicorn / httpx / pytest / ruff / pyright /
  pip-audit、pyright strict）を定義する（NFR-5）。
  _Boundary:_ `services/agent/pyproject.toml`, `services/agent/uv.lock`
  _Depends:_ none
  _Requirements:_ 2.1, NFR-5
- [ ] 4.2 `app/__init__.py` + `app/config.py` を作成し、env 検証（pydantic-settings）と judge model の
  **in-file allowlist**（`config.py` は NFR-2 carve-out 対象、他 `services/**` にモデル ID 直書き禁止）を実装する。
  _Boundary:_ `services/agent/app/__init__.py`, `services/agent/app/config.py`
  _Depends:_ 4.1
  _Requirements:_ 2.6, NFR-4
- [ ] 4.3 `app/telemetry.py` を作成し fail-soft OTel 初期化（collector 未設定でも起動）+ サニタイズ済み
  ログ（raw question/answer/context を出さない、識別子のみ）を実装する（Req 2.7/NFR-3）。
  _Boundary:_ `services/agent/app/telemetry.py`
  _Depends:_ 4.1
  _Requirements:_ 2.7, NFR-3
- [ ] 4.4 `app/main.py` を作成し FastAPI app 構築 + `/healthz` + telemetry フック（ステートレス:
  DB/Redis/FS 非接触、Req 2.3）を配線する。
  _Boundary:_ `services/agent/app/main.py`
  _Depends:_ 4.2, 4.3
  _Requirements:_ 2.1, 2.3
- [ ] 4.5 `tests/test_config.py` を作成し env 検証 + judge allowlist（範囲外モデル拒否）をネットワーク
  ゼロで検証する（Red-Green）。
  _Boundary:_ `services/agent/tests/test_config.py`
  _Depends:_ 4.2
  _Requirements:_ 2.6, 2.4
- [ ] 4.6 `scripts/forbid-model-ids.sh` の走査を `services/**` `*.py` へ拡張し、`services/agent/app/config.py`
  を carve-out に加える（補正 1 — 免除追加でなく走査範囲拡張、既存 TS carve-out は不変、NFR-2）。
  _Boundary:_ `scripts/forbid-model-ids.sh`
  _Depends:_ 4.2
  _Requirements:_ NFR-2
- [ ] 4.7 `mise.toml` に `py:check`（uv sync + ruff + pyright + pytest）を追加する（**`check` 集約の
  非依存**、TS ゲートは Python ツールチェーン無しで緑を維持、Req 2.5/NFR-1）。
  _Boundary:_ `mise.toml`
  _Depends:_ 4.1
  _Requirements:_ 2.5, NFR-1
- [ ] 4.8 `services/agent/README.md` を作成し `uv run` 起動・env・S2S トークン方針（ブラウザ非公開）を記述する（ADR-C、NFR-4）。
  _Boundary:_ `services/agent/README.md`
  _Depends:_ 4.4
  _Requirements:_ NFR-4

## 5. `/eval/faithfulness`・`/eval/relevancy` エンドポイント

LlamaIndex の低レベル `evaluate` を judge 注入で呼ぶ 2 エンドポイントを実装する。Pydantic 境界
モデルは新 HTTP 境界の正本（Req 3.1）。

_Boundary:_ `services/agent/app/schemas.py`, `services/agent/app/eval/__init__.py`, `services/agent/app/eval/llama.py`, `services/agent/app/routes/__init__.py`, `services/agent/app/routes/eval.py`, `services/agent/tests/conftest.py`, `services/agent/tests/test_eval.py`
_Depends:_ 4
_Requirements:_ 2.2, 2.4, 3.1

- [ ] 5.1 `app/schemas.py` に eval I/O の Pydantic モデル（`{question, contexts, answer}` →
  `{score, verdict, judge_model, usage}`）を定義する（新 HTTP 境界の正本、Req 3.1）。
  _Boundary:_ `services/agent/app/schemas.py`
  _Depends:_ 4.4
  _Requirements:_ 2.2, 3.1
- [ ] 5.2 `app/eval/llama.py` に judge 注入した `FaithfulnessEvaluator`/`RelevancyEvaluator` ラッパを
  実装する（低レベル `evaluate(query, response, contexts)`、`EvaluationResult`→`{score, verdict}` 写像、
  judge は `config.py` から解決）。
  _Boundary:_ `services/agent/app/eval/__init__.py`, `services/agent/app/eval/llama.py`
  _Depends:_ 5.1, 4.2
  _Requirements:_ 2.2, 2.6
- [ ] 5.3 `tests/conftest.py` に決定論 judge フェイク + `httpx.ASGITransport`（in-process ASGI、
  ネットワークゼロ、Req 2.4）を用意する（Red-Green 基盤）。
  _Boundary:_ `services/agent/tests/conftest.py`
  _Depends:_ 5.1
  _Requirements:_ 2.4
- [ ] 5.4 `app/routes/eval.py` に `POST /eval/faithfulness`・`/eval/relevancy` を実装し `main.py` へ登録する。
  _Boundary:_ `services/agent/app/routes/__init__.py`, `services/agent/app/routes/eval.py`
  _Depends:_ 5.2
  _Requirements:_ 2.2
- [ ] 5.5 `tests/test_eval.py` を作成し `/eval/*` の契約 + verdict/score 写像をフェイク judge で検証する
  （Red-Green、ネットワークゼロ、Req 2.2/2.4）。
  _Boundary:_ `services/agent/tests/test_eval.py`
  _Depends:_ 5.3, 5.4
  _Requirements:_ 2.2, 2.4

---

## Phase C — 境界契約の単一情報源（Req 3）

## 6. OpenAPI → 生成 TS 型 + 薄い Zod + 契約ドリフトテスト

FastAPI OpenAPI から TS 型を生成しコミット、薄い手書き Zod を conform させ、TS 側 vitest で 1 点
照合する（ADR-B）。再生成は mise タスク化。

_Boundary:_ `packages/schemas/src/generated/agent-service.ts`, `packages/schemas/src/generated/openapi.snapshot.json`, `packages/schemas/src/agent-service.ts`, `packages/schemas/tests/contract-drift.spec.ts`, `mise.toml`, `pnpm-workspace.yaml`, `package.json`
_Depends:_ 5
_Requirements:_ 3.2, 3.3, 3.4, 3.5

- [ ] 6.1 `openapi-typescript` を devDependency として宣言し、install script 有無を確認して
  `pnpm-workspace.yaml` の `allowBuilds` へ監査エントリを追加する（`minimumReleaseAge` 24h 尊重、
  生成物コミットで実行時依存ゼロ、Req 3.2）。
  _Boundary:_ `package.json`, `pnpm-workspace.yaml`
  _Depends:_ none
  _Requirements:_ 3.2
- [ ] 6.2 `mise.toml` に `openapi:gen`（`services/agent` の OpenAPI 出力 → `openapi-typescript` →
  `generated/agent-service.ts` 再生成 + スナップショット更新）を追加する（Req 3.5）。
  _Boundary:_ `mise.toml`
  _Depends:_ 6.1
  _Requirements:_ 3.5
- [ ] 6.3 `openapi:gen` を実行して `generated/openapi.snapshot.json` + `generated/agent-service.ts` を
  生成・コミットする（source-only 規約: no build step、Req 3.2）。
  _Boundary:_ `packages/schemas/src/generated/agent-service.ts`, `packages/schemas/src/generated/openapi.snapshot.json`
  _Depends:_ 6.2, 5.4
  _Requirements:_ 3.2
- [ ] 6.4 `src/agent-service.ts` に薄い手書き Zod（生成型に conform、ランタイム検証用）を定義する（Req 3.3）。
  _Boundary:_ `packages/schemas/src/agent-service.ts`
  _Depends:_ 6.3
  _Requirements:_ 3.3
- [ ] 6.5 `tests/contract-drift.spec.ts` を作成し、スナップショット ↔ 生成型 ↔ 薄い Zod を **1 点照合**
  する（どれかがズレたら 1 テストが落ちる、既存 vitest CI で常時実行、ADR-B、Req 3.4）。
  _Boundary:_ `packages/schemas/tests/contract-drift.spec.ts`
  _Depends:_ 6.4
  _Requirements:_ 3.4

---

## Phase D — 取り込み強化 / 構造保持パーシング（Req 4）

## 7. `/parse` エンドポイント + locator 永続化

Docling `HybridChunker` の `/parse` を追加し、`retrievedChunkSchema` + chunk テーブルに optional
`locator` を足す（既存テキスト ingest は byte 互換）。

_Boundary:_ `services/agent/app/schemas.py`, `services/agent/app/parse/__init__.py`, `services/agent/app/parse/docling.py`, `services/agent/app/routes/parse.py`, `services/agent/tests/test_parse.py`, `packages/rag/src/db/schema.ts`, `packages/rag/drizzle/NNNN_add_locator.sql`, `packages/schemas/src/rag.ts`
_Depends:_ 5
_Requirements:_ 4.1, 4.2, 4.3

- [ ] 7.1 `app/schemas.py` に `/parse` の Pydantic I/O（document + opt `use_llamaparse` →
  `{source, locator, ordinal, text}[]`）を追加する（新境界正本、Req 4.1）。
  _Boundary:_ `services/agent/app/schemas.py`
  _Depends:_ 5.1
  _Requirements:_ 4.1
- [ ] 7.2 `app/parse/docling.py` に Docling 変換 + `locator`（page→section→char）組立てと LlamaParse
  opt-in フォールバック（env キー無時は Docling、エラー無し）を実装する（Req 4.1/4.2）。
  _Boundary:_ `services/agent/app/parse/__init__.py`, `services/agent/app/parse/docling.py`
  _Depends:_ 7.1, 4.2
  _Requirements:_ 4.1, 4.2
- [ ] 7.3 `app/routes/parse.py` に `POST /parse` を実装し `main.py` へ登録する。
  _Boundary:_ `services/agent/app/routes/parse.py`
  _Depends:_ 7.2
  _Requirements:_ 4.1
- [ ] 7.4 `tests/test_parse.py` を作成し **チャンク→契約写像を決定論フェイクで検証**する（実 Docling
  変換は E2E/手動レーンに寄せる、ネットワークゼロ、Req 4.1/2.4）。
  _Boundary:_ `services/agent/tests/test_parse.py`
  _Depends:_ 7.3
  _Requirements:_ 4.1, 4.2
- [ ] 7.5 (P) `packages/schemas/src/rag.ts` の `retrievedChunkSchema` に optional `locator` を追加する
  （既存フィールドは不変、Req 4.3）。
  _Boundary:_ `packages/schemas/src/rag.ts`
  _Depends:_ none
  _Requirements:_ 4.3
- [ ] 7.6 `packages/rag/src/db/schema.ts` の `chunk` テーブルに nullable `locator` 列を足し、
  migration `drizzle/NNNN_add_locator.sql`（既存行 NULL 既定）を生成する（drizzle-zod 自動反映、
  byte 互換、Req 4.3）。
  _Boundary:_ `packages/rag/src/db/schema.ts`, `packages/rag/drizzle/NNNN_add_locator.sql`
  _Depends:_ none
  _Requirements:_ 4.3

## 8. ingest CLI `--via-parser` 経路 + 検証

`/parse` の返却チャンクを**既存 embed+upsert 経路**へ供給する `--via-parser` を足す。単一ライター
不変、provenance 不変、サービス到達不可時 fail-loud。

_Boundary:_ `packages/rag/src/ingest/index.ts`, `packages/rag/tests/via-parser.spec.ts`, `apps/web/tests/e2e/locator-citation.spec.ts`
_Depends:_ 7
_Requirements:_ 4.4, 4.5, 4.6

- [ ] 8.1 `tests/via-parser.spec.ts` を先行作成し（Red-Green）、(a) `--via-parser` が embed+upsert を
  再利用し `assertNoProviderMixing` の provenance が不変、(b) サービス到達不可で fail-loud、
  (c) 既定（非 parser）経路が byte 互換、を固定する。
  _Boundary:_ `packages/rag/tests/via-parser.spec.ts`
  _Depends:_ 7.6
  _Requirements:_ 4.4, 4.6
- [ ] 8.2 `packages/rag/src/ingest/index.ts` に `--via-parser` 経路を実装する（`AGENT_SERVICE_URL` へ
  POST → 返却チャンクを既存 embed+upsert へ、embedding 生成/pgvector 書き込みは `@vaz/rag` に限定 =
  単一ライター、到達不可時は actionable error で fail-loud、既定経路は不変、Req 4.4/4.6）。
  _Boundary:_ `packages/rag/src/ingest/index.ts`
  _Depends:_ 8.1, 7.3, 7.6
  _Requirements:_ 4.4, 4.6
- [ ] 8.3 `apps/web/tests/e2e/locator-citation.spec.ts` を作成し、PDF コーパスを `--via-parser` で
  ingest → チャット引用に `locator` が出ることをローカルスタックで検証する（Req 4.5）。
  _Boundary:_ `apps/web/tests/e2e/locator-citation.spec.ts`
  _Depends:_ 8.2
  _Requirements:_ 4.5

---

## Phase E — 評価還流・ゲート・文書（Req 5, 6）

## 9. golden set 拡充 + nightly tier2

golden set を ≥20 件へ拡充し、nightly に忠実性/関連性の tier2 ステージ（未設定時 skip）を足す。

_Boundary:_ `packages/evals/src/nightly.ts`, `packages/evals/src/tier2.ts`, `packages/evals/README.md`, `.github/workflows/eval-nightly.yml`
_Depends:_ 5
_Requirements:_ 5.1, 5.2

- [ ] 9.1 `src/nightly.ts` の `GOLDEN_SET` を **≥20 件**へ拡充し（audit log 由来の実会話/失敗、
  R4.7 匿名化）、`packages/evals/README.md` に出所・匿名化手順を記述する（Req 5.1）。
  _Boundary:_ `packages/evals/src/nightly.ts`, `packages/evals/README.md`
  _Depends:_ none
  _Requirements:_ 5.1
- [ ] 9.2 `src/tier2.ts` に `/eval/faithfulness`・`/eval/relevancy` クライアント（per-case スコア、
  薄い Zod で応答検証）を実装し、`runNightlyEval` に tier2 ステージを足す（**サービス未設定時は
  skip（fail ではない）**、既存 cost cap 内、Req 5.2）。
  _Boundary:_ `packages/evals/src/tier2.ts`, `packages/evals/src/nightly.ts`
  _Depends:_ 9.1, 6.4
  _Requirements:_ 5.2
- [ ] 9.3 `.github/workflows/eval-nightly.yml` に tier2 ステージを既存 nightly へ追加する（既存
  secrets ゲート機構を再利用、`AGENT_SERVICE_URL` 未設定時 skip、補正 2: 重複ワークフロー新設なし）。
  _Boundary:_ `.github/workflows/eval-nightly.yml`
  _Depends:_ 9.2
  _Requirements:_ 5.2

## 10. PR 評価ゲート（3 指標 / report-only 半制御）

前回比 pass-rate delta・over/under-trigger balance・per-case cost/latency を既存機構上に算出し、
<20 件は非ブロックとする。

_Boundary:_ `packages/evals/src/pr-gate.ts`, `packages/evals/tests/pr-gate.spec.ts`, `.github/workflows/eval-pr.yml`
_Depends:_ 9
_Requirements:_ 5.3, 5.4

- [ ] 10.1 `tests/pr-gate.spec.ts` を先行作成し（Red-Green）、3 指標算出と report-only 閾値ロジック
  （golden set <20 件は非ブロック）を固定する。
  _Boundary:_ `packages/evals/tests/pr-gate.spec.ts`
  _Depends:_ 9.1
  _Requirements:_ 5.3, 5.4
- [ ] 10.2 `src/pr-gate.ts` に 3 指標算出（baseline 前回比、trigger balance、per-case cost・latency）と
  report-only 半制御を実装する（既存 per-case baseline を PR 用に流用、Req 5.3/5.4）。
  _Boundary:_ `packages/evals/src/pr-gate.ts`
  _Depends:_ 10.1
  _Requirements:_ 5.3, 5.4
- [ ] 10.3 `.github/workflows/eval-pr.yml`（PR trigger）を新設し、既存 `eval-nightly.yml` の secrets
  ゲート機構を再利用して 3 指標を report する（閾値ブロックは 9.1 の ≥20 件達成後に有効化、Req 5.3/5.4）。
  _Boundary:_ `.github/workflows/eval-pr.yml`
  _Depends:_ 10.2
  _Requirements:_ 5.3, 5.4

## 11. supervisor doc-gen 検証ステップ（Doer-Verifier / RV-7）

doc-gen に optional 検証ステップ（機械チェック→`/eval/*` opt-in、成果物+基準のみ、失敗時 JobEvent）を足す。

_Boundary:_ `packages/agents/src/supervisor.ts`, `packages/agents/tests/supervisor-verify.spec.ts`
_Depends:_ 5, 1
_Requirements:_ 5.5, 5.6, 5.7

- [ ] 11.1 `tests/supervisor-verify.spec.ts` を先行作成し（Red-Green）、(a) 未設定時は既定挙動不変、
  (b) verifier は成果物 + 受入基準のみ受領（会話履歴を渡さない）、(c) 検証失敗時に閉じた語彙で
  `JobEvent` を emit、を固定する。
  _Boundary:_ `packages/agents/tests/supervisor-verify.spec.ts`
  _Depends:_ 1.4
  _Requirements:_ 5.5, 5.6, 5.7
- [ ] 11.2 `src/supervisor.ts` の doc-gen に optional 検証ステップを実装する（機械チェック=引用参照
  存在/format 適合を TS で先行、LLM verifier は `/eval/*` opt-in、既定は unset で挙動不変、
  失敗時 `JobEvent` は Req 1.4/1.5 の閉じた語彙、Req 5.5/5.6/5.7）。
  _Boundary:_ `packages/agents/src/supervisor.ts`
  _Depends:_ 11.1, 5.4
  _Requirements:_ 5.5, 5.6, 5.7

## 12. ガバナンス文書（AgentOps ランブック / MCP ADR）

3 本柱写像と MCP 採用判断を文書として固定し、CLAUDE.md から到達可能にする。

_Boundary:_ `docs/agentops.md`, `docs/adr/0001-mcp-position.md`, `CLAUDE.md`
_Depends:_ none
_Requirements:_ 6.1, 6.2, 6.3

- [ ] 12.1 `docs/agentops.md` を作成し AgentOps 3 本柱（可観測性=OTel span/audit log/Req 1.4 metrics /
  評価=3-tier+tier2/Req 5 還流 / 最適化=cost-latency-loop 閾値）をリポジトリ実装へ写像する（未実装は
  本 spec の要件 ID で参照、Req 6.1）。
  _Boundary:_ `docs/agentops.md`
  _Depends:_ none
  _Requirements:_ 6.1
- [ ] 12.2 (P) `docs/adr/0001-mcp-position.md` を作成し、MCP 非採用理由 + 採用条件（>3 外部 SaaS /
  マルチホスト共有 / ベンダ MCP サーバ判断）+ 事前設計原則（AI SDK v7 MCP client、`needsApproval`↔
  MCP destructive-annotation 写像表、供給網 vetting、R5.2/R5.3 適用）+ §5.1 脅威モデル/§5.2 ポリシ例
  参照を記述する（Req 6.2/6.3）。
  _Boundary:_ `docs/adr/0001-mcp-position.md`
  _Depends:_ none
  _Requirements:_ 6.2, 6.3
- [ ] 12.3 `CLAUDE.md` に `docs/agentops.md` と MCP ADR への到達リンクを足す（Req 6.1）。
  _Boundary:_ `CLAUDE.md`
  _Depends:_ 12.1, 12.2
  _Requirements:_ 6.1

---

## 並列実行の指針（tasks-parallel-analysis）

- **Wave A（Phase A）**: Task 1 → 2 → 3 は逐次だが、1.2 / 1.3 は 1.1 後に (P) で並走可。Phase A は
  Phase B〜E に一切依存しないため、**独立トラックとして先行着地**できる（NFR-1、M1）。
- **Wave B（Phase B）**: Task 4 → 5 は逐次。4 内は 4.2/4.3 が (P)。Phase B 完了が C/D/E(tier2) の前提。
- **Wave C/D（並走可）**: Task 6（Phase C）と Task 7→8（Phase D）は共に Task 5 に依存するが**互いに
  素**（C は `packages/schemas/**`+CI、D は `services/agent/parse`+`packages/rag`+`@vaz/schemas/rag`）で
  並走できる。7.5/7.6 は Phase B 非依存のため Phase A 完了後いつでも (P)。
- **Wave E（Phase E）**: Task 9 → 10（9.1 の ≥20 件が 10.3 の閾値ブロック有効化の前提）。Task 11 は
  Task 5（`/eval/*`）+ Task 1（語彙）依存で C/D と並走可。Task 12 は完全独立（12.1 のみ Task 2 の
  メトリクス着地後が望ましい）。

## マイルストーン対応（spec Exit Criteria）

- **M1（Phase A）**: Task 1–3 完了。tier3 nightly の before/after 記録（Req 1.8、Task 9 還流ループ初回行使）。
- **M2（Phase B+C）**: Task 4–6 完了。`mise run py:check` green、契約ドリフトテスト CI 通過、nightly が
  忠実性/関連性を non-blocking 出力（Task 9.2）。
- **M3（Phase D）**: Task 7–8 完了。PDF `--via-parser` → チャット引用に locator の E2E 通過、既存 ingest byte 互換。
- **M4（Phase E）**: Task 9–12 完了。golden set ≥20、閾値未達 PR ブロック、`docs/agentops.md` と MCP ADR が
  CLAUDE.md から到達可能。

---

_Tasks generated: 2026-07-19_
