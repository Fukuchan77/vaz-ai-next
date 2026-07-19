# 002-pydantic-enhance — Discovery & Research Log

`/sdd-plan` の一部として作成。設計判断の根拠となる調査・決定・リスクを記録する。
対象コミット `93ceccd`(ブランチ `002-pydantic-enhance`)。要件は承認済み。
`gap-analysis.md` が特定した調査項目 1〜6 をここで解消する。

## Discovery type

**混成** — Phase A / E(TS 本線)は既存システムの **Extension(light discovery)**、
Phase B / C / D(`services/` が未存在)は **New feature(full discovery)**。従って本ログは
Python サイドカーと言語境界を full、TS 拡張点を light で扱う。

## Investigations

### 1. AI SDK v7 の停止条件と終了理由 API(Req 1.3 / 1.4)

- **Question**: 累積トークン予算を `stopWhen` で表現できるか。`stop_reason` を捕捉する
  終了フックは何か。`usage` は累積か。
- **Findings**:
  - `StopCondition` は `(options: { steps: StepResult[] }) => boolean | PromiseLike<boolean>`。
    **累積 usage は引数に無く**、`steps[].usage`(各 `inputTokens`/`outputTokens`)を
    自前で reduce して算出する(公式 loop-control ドキュメントの `budgetExceeded` 例と同型)。
  - `stopWhen` は **配列可(OR 意味論)** — `isStepCount(MAX_STEPS)` と予算述語を並置できる。
  - `isStepCount(n)` は `({ steps }) => steps.length === n`。**素の `streamText` の既定は
    `isStepCount(1)`**(ToolLoopAgent は 20)。現行 `chat-agent.ts` は明示的に
    `isStepCount(MAX_STEPS)` を渡しているので複数ステップが回る。予算述語を足すときも
    この明示を維持する。
  - 終了フック: `onFinish` は **`onEnd` の deprecated エイリアス**。`OnEndResult` が
    `finishReason`(`"stop"|"length"|"content-filter"|"tool-calls"|"error"|"other"`)、
    `usage`(**最終ステップのみ**)、`totalUsage`(**全ステップ累積**)、`steps` を持つ。
    per-step は `onStepEnd`(`onStepFinish` は deprecated エイリアス)で `StepResult`。
  - **usage 形状は v7 で刷新**: `inputTokens`/`outputTokens`/`totalTokens`(旧
    `promptTokens`/`completionTokens` は撤廃)。`totalTokens` は reasoning 等を含み
    input+output と一致しない場合があるため、**予算判定は input+output の自前合算**を採る。
  - **決定的知見**: 予算超過で停止しても `finishReason` に固有値は出ない(最終ステップの
    モデル理由がそのまま出る)。よって `stop_reason` は **フック外で `{ finishReason,
    totalUsage, steps.length, budget, maxSteps }` から導出**する必要がある。
- **Evidence**: `node_modules/.pnpm/ai@7.0.14_*/node_modules/ai/dist/index.d.ts:1748-1750`
  (`StopCondition`), `:3518`(`stopWhen?: Arrayable<StopCondition>`), `:1757`(`isStepCount`);
  `dist/index.js:4560-4562`(`isStepCount` 実装), `:4982`(既定 `isStepCount(1)`);
  `docs/03-agents/04-loop-control.mdx:129-145`(予算述語例), `:147-225`(context 管理);
  `docs/07-reference/01-ai-sdk-core/02-stream-text.mdx:1619-1643`(`onEnd`/`finishReason`/
  `usage`), `:1732-1734`(`totalUsage`), `:1279-1308`(`onStepEnd`/`StepResult.usage`)。
- **決定 → ADR-A**(拡張採用)。`gap-analysis` の推奨(拡張優先)を確定。

### 2. `prepareStep` のコンテキスト窓化シーム(Req 1.7)

- **Question**: `prepareStep` で履歴を窓化(compaction)できるか。未設定時に現行と
  byte 等価に保てるか。
- **Findings**: `prepareStep` は入力 `PrepareStepOptions`(`steps`/`stepNumber`/`messages`/
  `runtimeContext` 等)を受け、戻り値 `PrepareStepResult` の `messages` を返すと
  **そのステップ以降の基底メッセージ集合を置換**できる(以降の応答は追記)。公式は
  `pruneMessages` ヘルパを `prepareStep` 内で使う窓化例を提示。現行
  `buildPrepareStep`([chat-agent.ts:114-128](../../packages/agents/src/chat-agent.ts#L114-L128))
  は RAG context 注入のみで `messages` は追記のみ返す。**窓化関数を optional 引数として
  足し、未指定時は現行の追記結果をそのまま返せば byte 等価**。
- **Evidence**: `docs/07-reference/01-ai-sdk-core/02-stream-text.mdx:640-644, 656-791`;
  `docs/03-agents/04-loop-control.mdx:189-225`。

### 3. LlamaIndex 評価器 API(Req 2.2)

- **Question**: `FaithfulnessEvaluator`/`RelevancyEvaluator` の構築・入出力・judge LLM 注入。
- **Findings**: `from llama_index.core.evaluation import FaithfulnessEvaluator,
  RelevancyEvaluator`。`Evaluator(llm=<judge>)` で構築。低レベル API は
  `evaluate(query=?, response=<answer str>, contexts=[<str>, ...])` を受け、
  `EvaluationResult`(`.passing: bool`、`.score: float`、`.feedback: str`)を返す。
  Faithfulness は `response`+`contexts`(query 任意)、Relevancy は `query`+`response`+
  `contexts` を要する。judge LLM は `llm=` で明示注入 — サイドカーは env から解決した
  judge を渡す(高レベル `evaluate_response` は QueryEngine 前提なので**使わない**;
  サイドカーは `{question, contexts, answer}` を受け取る低レベル `evaluate` を使う)。
- **Evidence**: LlamaIndex docs(context7 `/run-llama/llama_index`)
  `module_guides/evaluating/usage_pattern.md`、`understanding/evaluating/evaluating.md`。

### 4. Docling `HybridChunker`(Req 4.1)

- **Question**: PDF → 構造保持チャンク、`locator`(page→section→char)に要る位置情報。
- **Findings**: `DocumentConverter().convert(source).document` で `DoclingDocument` を得、
  `HybridChunker(tokenizer=HuggingFaceTokenizer.from_pretrained(model_name=..., max_tokens=...))
  .chunk(dl_doc=doc)` がチャンクを yield。各チャンクの `chunk.meta` に見出し
  (`headings`)と `doc_items[*].prov[*]`(`page_no`、bbox 等)があり、これらから
  `locator`(page→section→char 規約)を組み立てる。`chunking` extra が必要
  (`docling-core[chunking]`: semchunk/tree-sitter/transformers)。
- **Evidence**: context7 `/docling-project/docling-core`
  `test/test_hybrid_chunker.py`(HybridChunker 構築)、`types/doc/document.py`
  (`SectionHeaderItem.level`)。
- **⚠️ リスク**: HuggingFace トークナイザはモデル DL を伴う → ネットワークゼロの単体
  テストでは実 PDF 変換をテストせず、`/parse` の**チャンク→契約写像**を決定論フェイクで
  検証する(実 Docling 変換は E2E/手動レーンに寄せる)。

### 5. 契約単一情報源と openapi-typescript(Req 3)

- **Question**: FastAPI OpenAPI → TS 型生成の機構と供給網ゲート。ドリフト検証の置き場所。
- **Findings**: FastAPI は `app.openapi()`(dict)/`/openapi.json` で OpenAPI 3.1 を出す。
  `openapi-typescript <schema.json> -o packages/schemas/src/generated/agent-service.ts` で
  `.d.ts` 相当の型を生成しコミット(source-only 規約: no build step)。生成は build 化
  せず **mise タスク化**(`openapi:gen`)して手動/CI 再現に留める。ドリフト検証は **TS 側
  vitest**(生成型/薄い Zod ↔ コミット済み OpenAPI スナップショットを 1 点照合)が既存
  CI に載り常時実行できるため最適(ADR-B)。
- **供給網**: `openapi-typescript` は devDependency。install script 有無を確認し
  `allowBuilds` に監査エントリを追加、`minimumReleaseAge`(24h)を尊重。生成物はコミット
  されるので実行時依存は増えない。
- **Evidence**: FastAPI OpenAPI 慣行 + [pnpm-workspace.yaml] の `allowBuilds`/
  `minimumReleaseAge: 1440`(CLAUDE.md「供給網ゲート」)。

### 6. locator の永続化と pgvector byte 互換(Req 4.3)

- **Findings**: [chunk テーブル](../../packages/rag/src/db/schema.ts#L52-L70) は
  `id/documentId/ordinal/content` のみ。`locator` を **nullable 列**として追加 → 既存
  テキスト ingest は値未書き込み(NULL)で byte 互換。drizzle-zod の
  `chunkInsertSchema`/`chunkSelectSchema` は table 定義から単一ソース生成されるため、
  列追加で optional として自動反映(手書き禁止)。`retrievedChunkSchema`
  ([rag.ts:31-38](../../packages/schemas/src/rag.ts#L31-L38))にも `locator` を optional 追加。
  `EMBEDDING_DIM=768` と `assertNoProviderMixing`
  ([ingest/index.ts:116-132](../../packages/rag/src/ingest/index.ts#L116-L132))は不変
  (locator は embedding provenance と無関係)。
- **⚠️ リスク**: 列追加は migration を伴う。既存行は NULL 既定で後方互換。migration は
  Phase D に閉じ、Phase A〜C は DB 不変。

### 7. golden set 拡充と PR ゲート 3 指標(Req 5.1 / 5.3)

- **Findings**: 現状 golden set は 2 件
  ([nightly.ts:50-63](../../packages/evals/src/nightly.ts#L50-L63))。audit log
  (`auditLog` テーブル、tool/args/userId/jobId/ts)から実会話・失敗を抽出し R4.7 準拠で
  匿名化 → `packages/evals/README.md` に手順記載。PR ゲートは既存
  [eval-nightly.yml](../../.github/workflows/eval-nightly.yml)(schedule + workflow_dispatch、
  `ANTHROPIC_API_KEY` step-level gate)の機構を再利用し **PR trigger の別ワークフロー**を
  新設(補正 2: `evals.yml` 重複新設はしない)。3 指標 = 合格率前回比 / トリガーバランス /
  ケース平均コスト・レイテンシ。baseline 保持は `runNightlyEval` の per-case baseline
  ([nightly.ts:193-195])を PR 用に流用。

## Existing patterns to reuse

| Pattern | Location | Why reuse |
|---------|----------|-----------|
| デリミタ + 不信通知(system 権威側の対) | `packages/agents/src/prompt.ts:28-34` | `CHAT_SYSTEM_PROMPT`(1.1d)がこの定数を参照して権威側宣言を書けば R5.2 と一貫 |
| lazy provider 解決 + `options.model` テストシーム | `chat-agent.ts:161`, `supervisor.ts:203`, `nightly.ts:153` | 3 停止経路の MockLanguageModelV4 テスト(1.6)に流用 |
| 単一発火点の audit hook 配線 | `packages/agents/src/audit-hook.ts:57-80` | run-finish フック(1.4)を同じ deps-closure/optional-audit で足す |
| drizzle-zod 単一ソース契約 | `packages/rag/src/db/schema.ts:102-107` | locator 列追加が insert/select schema に自動反映(手書き禁止) |
| 単一ライター ingest 経路 | `packages/rag/src/ingest/index.ts:192-229` | `--via-parser` は embed+upsert を**再利用**し provenance 不変 |
| nightly の cost-cap + per-case baseline + skip 半制御 | `packages/evals/src/nightly.ts:66,147,236-243` | tier2 追加(5.2)と PR ゲート(5.3)の土台 |
| step-level secrets gate ワークフロー | `.github/workflows/eval-nightly.yml:25-35` | PR ゲート(5.3)と nightly tier2 の CI 機構 |
| discriminated union の optional 拡張 | `packages/schemas/src/workflows.ts:179-184` | `completion` に `metrics` optional 追加(1.5/NFR-6) |
| grep ゲート carve-out 方式 | `scripts/forbid-model-ids.sh:31-42` | 走査範囲を `services/**/*.py` に拡張 + `config.py` carve-out(NFR-2) |

## External dependencies

| Dependency | Version | Purpose | Verified |
|------------|---------|---------|----------|
| FastAPI | 最新安定 | `services/agent` HTTP 境界・OpenAPI 3.1 出力 | ✅ 慣行確認 |
| Pydantic / pydantic-settings | v2 系 | 境界正本モデル / env 検証(`config.py`) | ✅ |
| Pydantic AI | 最新安定 | 評価/検証エージェント構成(judge 呼び出しの型付き土台) | ✅ 設計文書 §3.1 |
| llama-index-core (+ judge LLM 統合) | 0.14 系 | `FaithfulnessEvaluator`/`RelevancyEvaluator` | ✅ context7 |
| docling / docling-core[chunking] | 最新安定 | `/parse` の `HybridChunker`(PDF 構造保持) | ✅ context7 |
| llama-parse | 任意(opt-in) | env キー存在時のみ高精度パース | ✅ opt-in 設計 |
| uvicorn / httpx | 最新安定 | ASGI 起動 / `httpx.ASGITransport` によるネットワークゼロ試験 | ✅ Req 2.4 |
| pytest / ruff / pyright / pip-audit | 最新安定 | `py:check`(uv sync + ruff + pyright + pytest)+ 供給網監査 | ✅ Req 2.5/NFR-5 |
| openapi-typescript | 最新安定(devDep) | OpenAPI → `generated/agent-service.ts`。install script 要確認 → `allowBuilds` | ⚠️ `minimumReleaseAge`/install script 確認要 |

## Architecture decisions

### ADR-A: トークン予算は `stopWhen` 配列 + フック外 `stop_reason` 導出(拡張)

- **Context**: v7 の `StopCondition` は累積 usage を引数に渡さず、予算停止は固有
  `finishReason` を生まない(調査 1)。
- **Decision**: (1) `stopWhen` を配列化し `isStepCount(MAX_STEPS)` に**累積トークン予算
  述語**(`steps[].usage` の input+output 合算 ≥ 閾値)を OR 併置。(2) `onEnd` で
  `{ finishReason, totalUsage, steps }` を集約し、**純粋関数 `deriveStopReason(...)`**
  でフック外導出。(3) 閉じた語彙 `runStopReasonSchema = z.enum(["natural","step-cap",
  "budget-exceeded","error"])` を `@vaz/schemas` に新設。導出優先順:
  `error` → `budget-exceeded` → `step-cap` → `natural`(`length`/`content-filter`/`other`
  は raw `finishReason` をテレメトリ属性に別途記録し、閉じた語彙は `natural` に畳む)。
- **Alternatives**: `onStepFinish` 自前カウンタ(gap-analysis 選択肢 A の「新規」)—
  累積 usage が届く以上不要。実装増を避け拡張を採る。
- **Consequences**: 予算は近似(ステップ完了粒度でしか止まらない — ステップ途中の超過は
  次の述語評価で捕捉)。純粋関数化で 3 経路の決定論テスト(1.6)が容易。

### ADR-B: 契約ドリフトテストは TS 側 vitest に置く

- **Context**: Pydantic 正本と生成 TS 型/薄い Zod の両端を照合する必要(Req 3.4)。
- **Decision**: コミット済み OpenAPI スナップショット ↔ 生成型 ↔ 薄い Zod を **vitest で
  1 点照合**(sandbox `test_contract_drift.py` と同型)。既存 pnpm/vitest CI に載り
  PR 毎に常時実行。`py:check` は `check` 非依存(2.5)ゆえ Python 側検証は補助に留める。
- **Alternatives**: Python pytest 内検証 — `check` 非依存で PR 常時実行にならない。
- **Consequences**: OpenAPI スナップショット再生成手順(`openapi:gen`)が前提。生成物・
  スナップショット・薄い Zod のどれがズレても 1 テストが落ちる。

### ADR-C: Python サービスは uv ローカル起動を既定、compose 統合は保留

- **Context**: spec は Phase B のコンテナ化を Out of Scope とし本番配備要件は未確定。
- **Decision**: `uv run` ローカル起動を既定とし、nightly/CI・ingest CLI からは
  `AGENT_SERVICE_URL`(env)で到達。`docker-compose.yml` への追記は本番配備要件が
  出た時点で追補。
- **Alternatives**: 即 compose 統合 — Phase B スコープを膨らませ NFR-1 の独立着地を阻害。
- **Consequences**: CI は `services/agent` を必要なジョブでのみ起動する配線が要る
  (tier2 未設定時は skip、5.2)。

### ADR-D: run-metrics 監査は AuditSink に optional `recordRun` を足し migration 回避

- **Context**: Req 1.4 は `stop_reason` を `deps.audit` に記録するが、既存 AuditSink は
  tool-call 中心(`{userId,jobId,tool,args,ts}`)。
- **Decision**: `AuditSink` に **optional** `recordRun?(entry: RunAuditEntry)` を追加
  (ADR-3 の optional-audit 慣行)。web/worker の具象 sink は既存 `auditLog` 行へ
  センチネル `tool:"__chat_run__"` + 安全集約 JSON(`stopReason`/token 数、raw 本文なし)
  として書き、**Phase A では DDL migration 不要**。専用列化は将来の任意最適化。
- **Alternatives**: `record` を tool 名でオーバーロード — 意図が不明瞭。専用列 + migration —
  Phase A の独立着地を重くする。
- **Consequences**: `@vaz/schemas/deps` の `AuditSink` 型に optional メソッド追加。未実装
  sink は no-op(後方互換)。R4.7 は run-metrics が非機微集約のため保持。

### ADR-E: JobEvent 拡張は `completion` バリアントの optional `metrics`

- **Context**: Req 1.5/5.7/NFR-6 — SSE wire 契約は後方互換必須。
- **Decision**: `runMetricsSchema`(`stopReason` + token 数 + `stepCount`)を新設し、
  `completion` イベントに `metrics: runMetricsSchema.optional()` を追加。既存の
  discriminated union / `jobEventTypeSchema` / DB enum は不変(型追加のみ)。
- **Consequences**: 旧クライアントは未知 optional を無視でき wire 互換。

## Risks & open questions

- ⚠️ **予算述語の粒度**: ステップ完了単位でしか停止できない — mitigation: 予算はハード
  上限でなく「次ステップ抑止」閾値と位置づけ、`MAX_STEPS` を安全網として併存(ADR-A)。
- ⚠️ **system プロンプト導入で eval verdict が変わりうる**(Req 1.8)— mitigation:
  マージ前に tier3 nightly の before/after を記録(Req 5 還流ループ初回行使)。
- ⚠️ **Docling のモデル DL**(調査 4)— mitigation: 単体はチャンク→契約写像を決定論
  フェイクで検証、実変換は E2E/手動レーン。
- ⚠️ **openapi-typescript の install script / release age**(調査 5)— mitigation:
  `allowBuilds` 監査エントリ + `minimumReleaseAge` 尊重、生成物コミットで実行時依存ゼロ。
- ⚠️ **サービス到達不可時の ingest**(Req 4.6)— mitigation: `--via-parser` は fail-loud、
  既定(非 parser)経路は不変。
- ❓ **`CHAT_TOKEN_BUDGET` 既定値**: 業務適用の実測が無い段階の初期値 — plan は保守的な
  既定(例 200_000)を置き env で調整可能とする(Phase A 着地後の nightly で再調整)。
- ❓ **PR ゲートの baseline 保存先**: 前回比の baseline を artifact/commit のどちらで
  持つか — Phase E(5.3)実装時に決定(report-only 期間に方式を確定)。
