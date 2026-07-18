# 002-pydantic-enhance

## Project Description

本フィーチャは、2 つの設計文書を再レビュー・実コード検証した上で、その帰結を
**実装可能なアップグレード計画**として要件化する:

1. [`docs/agentic-engineering-review.md`](../../docs/agentic-engineering-review.md)
   (コミット `d3208e6`) — 8 手法レビュー。指摘 V-1..V-7、計画 RV-1..RV-7。
2. [`docs/pydantic-llamaindex-fastapi-enhancement.md`](../../docs/pydantic-llamaindex-fastapi-enhancement.md)
   (コミット `b3b8604`) — PydanticAI + LlamaIndex (+FastAPI) ハイブリッド強化検討。
   選択肢 B(Python サイドカー)採用、計画 PL-1..PL-4、Phase C(フルハイブリッド)保留。

方針の骨子は両文書から継承する: **本線(チャット/ジョブ)は VAZ スタックのまま強化し
(RV 系)、Python は「データ・評価処理層」限定のステートレスサイドカー `services/agent`
(FastAPI + Pydantic AI + LlamaIndex)として追加する(PL 系)**。本 spec は両計画を
1 つの要件セットに統合し、EARS 受入基準・フェーズ境界・トレーサビリティを固定する。

### 再検証結果(2026-07-18、対象コミット `b3b8604`)

両文書の主張を実コードと照合した。**設計判断を覆す齟齬は無し**。確認結果と補正 2 件:

**確認済み(抜粋)**:

- V-1: `buildStreamTextOptions`(`packages/agents/src/chat-agent.ts:153-175`)は `system`
  を渡していない。supervisor の doc-gen 専門家には 2 文の system がある
  (`supervisor.ts:207-211` 付近。レビュー記載の行番号から微ズレのみ)。
- V-2: 停止条件は `stopWhen: isStepCount(5)` のみ。`onFinish` での usage/停止理由の
  監査・テレメトリ出力は無い。コストキャップは nightly 評価のみ
  (`DEFAULT_COST_CAP_TOKENS = 50_000`、`EVAL_NIGHTLY_COST_CAP_TOKENS` で上書き)。
- R5.2/R5.3: デリミタ定数 + 不信通知(`prompt.ts`)、`prepareStep` 経由の 1 回注入、
  sticky taint(`externallyDriven` ラッチ)は文書どおり配線済み。
- ingest は `.md`/`.mdx`/`.txt` のみ。embedding 書き込みは `createEmbedder` が
  provenance(provider/model/dim)を刻む単一経路で、`assertNoProviderMixing` が
  混在を拒否。次元は DDL 固定 768。
- `retrievedChunkSchema`(`@vaz/schemas/rag`)に `locator` フィールドは無い
  (PL-2 の optional 追加は新規追加で正しい)。
- golden set は現在 **2 ケース**(`current-time` / `platform-summary`)。RV-4 の
  「20 件以上へ拡充」は前提として妥当。

**補正(本 spec で計画を修正する 2 点)**:

- **補正 1 — モデル ID ゲートの適用方式**: 強化検討 §3.4 は「`services/agent/app/config.py`
  を第 3 の免除ファイルに追加」としたが、`scripts/forbid-model-ids.sh` の実装は
  `apps/**`・`packages/**` の `*.ts`/`*.tsx` のみを走査し、`packages/config/` は
  **ディレクトリごと**除外している。Python ファイルはそもそも走査対象外のため、
  「免除追加」ではなく**走査対象の拡張(`services/**` の `*.py`)+ `config.py` の
  carve-out 追加**が正しい変更である(→ NFR-2)。
- **補正 2 — 評価 CI の置き場所**: 強化検討 §3.1 は `.github/workflows/evals.yml` 新設と
  したが、`eval-nightly.yml`(schedule + workflow_dispatch、Secrets ゲート付き)が
  既存。tier2 忠実性評価は**既存 nightly への追加**とし、PR ゲートのみ新規
  ワークフローとする(→ Req 5)。

## Clarifications

### Session 2026-07-18(強化検討文書 §2/§3/§6 で確定済みの設計判断を継承)

- Q: ハイブリッド構成の適用範囲は? → A: **選択肢 B(Python サイドカー)**。チャット/
  ジョブ本線は VAZ のまま。Phase C(Pydantic AI + `VercelAIAdapter` への本線移行)は
  採用条件(強化検討 §5)成立まで非着手(Out of Scope)。
- Q: Python サービスは DB に書くか? → A: **書かない(単一ライター原則)**。解析・評価は
  Python、embedding 生成と pgvector 書き込みは既存 TS ingest のまま。768 次元 DDL と
  `assertNoProviderMixing` を無傷に保つ。
- Q: 言語境界のスキーマ正本は? → A: **新設 HTTP 境界のみ Pydantic 正本** →
  OpenAPI → `openapi-typescript` 生成 + 薄い Zod + ドリフトテスト。既存 Zod 契約は不変。
- Q: LlamaParse(外部 SaaS)は必須か? → A: **opt-in**(env キー存在時のみ)。既定は
  Docling(ローカル実行)。
- Q: RV 計画との優先順位は? → A: **RV-1..RV-7 の優先順位は不変**。RV-1/RV-2 を先行着地
  (Req 1)、RV-4/RV-7 は評価ゲート(Req 5)に、RV-5/RV-6 は文書要件(Req 6)に合流。

## Scope

- **In scope**(Phase A〜E の段階的アップグレード):
  - **Phase A(TS 本線強化)**: RV-1 チャット system プロンプト / RV-2 ループ予算と
    停止理由監査 / RV-3(a) コンテキスト予算方針文書 + (b) compaction seam。
  - **Phase B(評価サイドカー)**: `services/agent`(FastAPI、uv、pyright strict)新設。
    `/eval/faithfulness`・`/eval/relevancy`(LlamaIndex 評価モジュール)。
  - **Phase C(境界契約)**: OpenAPI → TS 型生成、薄い Zod、契約ドリフトテスト CI。
  - **Phase D(取り込み強化)**: `/parse`(Docling `HybridChunker`、LlamaParse opt-in)、
    `locator` optional 追加、ingest CLI `--via-parser` 経路。
  - **Phase E(評価還流・ゲート・文書)**: golden set ≥20 件、tier2 忠実性の nightly 統合、
    PR 評価ゲート(3 指標)、doc-gen 検証ステップ(RV-7)、`docs/agentops.md`(RV-5)、
    MCP ポジション ADR(RV-6 + sandbox NR-1 写像表)。
- **Out of scope**:
  - チャット/ジョブ本線の Pydantic AI + `VercelAIAdapter` 移行(強化検討 §5 の採用条件と
    移行コスト台帳が成立条件。成立時に別 spec)
  - リポジトリ全体のスキーマ正本の Pydantic 統一(境界単位の正本固定で足りる)
  - Python サービスからの DB 直接読み書き(単一ライター原則)
  - LlamaParse の既定有効化・機密文書の外部送信判断(運用側の判断事項)
  - MCP クライアント/サーバの実装(RV-6 は ADR 文書のみ)
  - Managed Agents / アクセスバンドル等の運用基盤選定(レポート §4.2/§5.3)

## Glossary

| 用語 | 定義 |
|------|------|
| サイドカー | 本線(web/worker)から HTTP でのみ呼ばれるステートレス補助サービス。`services/agent`。`@vaz/*` 依存グラフの外に置く。 |
| 単一ライター原則 | pgvector への embedding 書き込み経路を既存 TS ingest の 1 箇所に限定する原則。provenance(provider/model/dim)汚染を構造的に防ぐ。 |
| Faithfulness / Relevancy | LlamaIndex の RAG 評価指標。回答が取得コンテキストに忠実か(ハルシネーション有無)/ 質問に関連するか。 |
| tier2 評価 | 既存 3 層(tier1 unit / recall@k / tier3 judge)に追加する RAG 忠実性・関連性の回帰評価層。 |
| locator | 文書種別非依存の位置アンカー(page→section→char 規約、sandbox ADR-4 由来)。PDF 由来チャンクの引用表示に必要。 |
| 契約ドリフトテスト | Pydantic 正本と生成 TS 型/薄い Zod の互換性を 1 点で照合する CI テスト(sandbox `test_contract_drift.py` と同型)。 |
| stop_reason | run 終了理由の閉じた語彙(step 上限 / 予算超過 / 自然終了 / エラー)。監査・テレメトリへ出力する。 |
| Doer-Verifier | 成果物の生成者と検証者を分離する構成。Verifier には会話履歴を渡さず成果物と受け入れ基準のみ渡す。 |

## Requirements

<!--
EARS 形式(rules/ears-format.md)。受入基準は階層番号(1.1, 1.2 …)で採番し、
plan.md / tasks.md のトレーサビリティキーとする。[U]/[E]/[S]/[O]/[X] は EARS パターン注記。
主体規約は 001 と同じ(既定主語 THE VAZ platform、個別主体は具体名)。
-->

### Requirement 1: チャット本線の TS 強化 — system プロンプト・ループ予算・コンテキスト方針(Phase A / RV-1, RV-2, RV-3)

**User Story**: 運用者として、チャットエージェントの役割・防御の権威側宣言と、実行コストの
上限・停止理由の監査を持ちたい。理由: R5.2 の不信デリミタは system の権威との対比で効き、
コスト可視性なしに業務適用の運用判断ができないため。

**Acceptance Criteria**:

1.1 [U] `packages/agents/src/prompt.ts` SHALL export a `CHAT_SYSTEM_PROMPT` constant covering (a) role/tone, (b) tool-usage policy (when to call `searchDocuments`), (c) citation format (`[source#ordinal]`), and (d) an authority-side declaration that delimited retrieved context is reference data, not instructions.
1.2 [U] `buildStreamTextOptions` SHALL pass `CHAT_SYSTEM_PROMPT` as `system`, and unit tests SHALL verify both the prompt content (delimiter mention, citation format) and its presence in the built options.
1.3 [U] THE chat agent's `stopWhen` SHALL combine `isStepCount(MAX_STEPS)` with a cumulative token-budget condition, whose threshold SHALL be validated by the Zod env schema (`@vaz/schemas/env`) with a default.
1.4 [E] WHEN a chat run finishes, THE chat agent SHALL map `{ finishReason, usage, steps }` to a closed `stop_reason` vocabulary and record it to telemetry span attributes and `deps.audit` (no raw prompts / tool args — R4.7 preserved).
1.5 [U] THE supervisor workflow SHALL emit the same run-metrics shape as an optional (backward-compatible) `JobEvent` extension, with the Zod contract in `@vaz/schemas/workflows` updated without drift.
1.6 [U] All three termination paths (budget exceeded / step cap / natural finish) SHALL be covered by `MockLanguageModelV4` unit tests.
1.7 [U] `docs/context-budget.md` SHALL document the current context policy (full history sent, step-count cap only) and the staged compaction approach; `prepareStep` SHALL gain an opt-in history-windowing seam that is byte-equivalent to current behavior when unset.
1.8 [X] IF the existing tier1/tier3 evals change verdicts due to the system prompt, THEN a before/after nightly comparison SHALL be recorded prior to merge (first exercise of the Req 5 feedback loop).

### Requirement 2: Python 評価サイドカー `services/agent`(Phase B / PL-1)

**User Story**: 開発者として、LlamaIndex の Faithfulness/Relevancy 評価を本リポジトリの
評価基盤から呼びたい。理由: RAG 忠実性(ハルシネーション有無)の回帰監視が TS 側に無く、
再発明せず Python エコシステムの実装を使うため。

**Acceptance Criteria**:

2.1 [U] THE VAZ platform SHALL add `services/agent/` (FastAPI + Pydantic AI + LlamaIndex, uv-managed, pyright strict) outside the `@vaz/*` dependency graph; no TypeScript package SHALL import from it and it SHALL NOT import workspace TS sources (HTTP boundary only).
2.2 [U] `services/agent` SHALL expose `POST /eval/faithfulness` and `POST /eval/relevancy` accepting `{question, contexts, answer}` and returning `{score, verdict, judge_model, usage}` per case.
2.3 [U] THE Python service SHALL be stateless: no database, Redis, or filesystem persistence; all inputs arrive in the request.
2.4 [U] THE Python unit-test lane SHALL run with zero network I/O (deterministic fakes for the judge LLM, in-process ASGI via `httpx.ASGITransport` — the sandbox `block_network` discipline).
2.5 [U] A `py:check` mise task (uv sync + ruff + pyright + pytest) SHALL exist and SHALL NOT be a dependency of the existing `check` aggregate (TS gates stay green without a Python toolchain).
2.6 [O] WHERE judge-model selection is needed, THE Python service SHALL read it from env validated in `services/agent/app/config.py` against an in-file allowlist; model IDs SHALL NOT be hardcoded elsewhere in `services/**` (see NFR-2).
2.7 [U] OTel instrumentation SHALL be fail-soft (service starts without collector config) and span attributes SHALL reuse the `gen_ai.*` conventions plus `caseId`/`jobId` correlation keys used by the TS side.

### Requirement 3: 境界契約の単一情報源(Phase C / PL-1)

**User Story**: 開発者として、言語境界の型を二重定義せず、ドリフトを CI で検知したい。
理由: Zod と Pydantic の同一構造二重定義は必ずドリフトするため(強化検討 §3.3)。

**Acceptance Criteria**:

3.1 [U] THE Pydantic models of `services/agent`'s endpoints SHALL be the single source of truth for the new HTTP boundary; existing Zod contracts (`chatRequestSchema`, `jobEvent`, rag, env) SHALL remain authoritative and unchanged.
3.2 [U] TypeScript boundary types SHALL be generated from the FastAPI OpenAPI schema via `openapi-typescript` into `packages/schemas/src/generated/agent-service.ts`, and the generated file SHALL be committed (source-only package rule; no build step).
3.3 [U] Runtime validation on the TS side (e.g. nightly consuming eval results) SHALL use thin hand-written Zod schemas conforming to the generated types.
3.4 [X] IF the OpenAPI schema and the committed generated types (or the thin Zod schemas) diverge, THEN a single contract-drift CI test SHALL fail (same one-point verification shape as sandbox `test_contract_drift.py`).
3.5 [E] WHEN the Pydantic models change, THE regeneration command SHALL be a documented mise task so the update path is mechanical.

### Requirement 4: 文書取り込みの強化 — 構造保持パーシング(Phase D / PL-2)

**User Story**: 利用者として、PDF 等の複雑文書も社内コーパスに取り込み、位置情報付きの
引用で回答してほしい。理由: 現行 ingest はテキスト系 3 拡張子のみで、業務文書の大半を
取り込めないため。

**Acceptance Criteria**:

4.1 [U] `services/agent` SHALL expose `POST /parse` accepting a document (PDF at minimum) and returning structure-preserving chunks `{source, locator, ordinal, text}` using Docling's `HybridChunker` by default.
4.2 [O] WHERE a LlamaParse API key is present in env, THE parse path MAY use LlamaParse; without the key it SHALL fall back to Docling with no error (LlamaParse is opt-in, never required).
4.3 [U] `retrievedChunkSchema` and the chunk persistence schema SHALL gain an **optional** `locator` field (page→section→char convention); existing text-file ingest SHALL remain byte-compatible (no value written, all existing tests unchanged).
4.4 [U] THE ingest CLI SHALL gain a `--via-parser` path that sends files to `/parse` and feeds returned chunks into the **existing** embed+upsert path; embedding generation and pgvector writes SHALL remain exclusively in `packages/rag` (single-writer), and a test SHALL pin that `assertNoProviderMixing` provenance is unaffected.
4.5 [E] WHEN a PDF corpus is ingested via `--via-parser` and queried through chat, THE citation SHALL surface the `locator` (E2E-verified against the local stack).
4.6 [X] IF `services/agent` is unreachable, THEN the `--via-parser` ingest SHALL fail loudly with a actionable error; the default (non-parser) ingest path SHALL be unaffected.

### Requirement 5: 評価の還流と CI ゲート(Phase E / RV-4, PL-3, RV-7)

**User Story**: メンテナとして、プロンプト・モデル・インデックス変更が品質退行を起こしたら
PR 段階で検知したい。理由: 評価は自動化された第一防衛線であり、忠実性軸と本番還流が
現状欠けているため(golden set は現在 2 ケース)。

**Acceptance Criteria**:

5.1 [U] THE golden set SHALL be expanded to ≥20 cases sourced from real conversations/failures via the audit log, anonymized per the R4.7 privacy contract, with the sourcing procedure documented in `packages/evals/README.md`.
5.2 [U] THE nightly run SHALL add a tier2 stage that calls `/eval/faithfulness` and `/eval/relevancy` per golden case, recording scores per case within the existing cost cap; tier2 SHALL be skipped (not failed) when the Python service is not configured.
5.3 [U] A new PR-gate workflow SHALL report three metrics — pass-rate delta vs. previous, over/under-trigger balance, and per-case average cost/latency — building on the existing `eval-nightly.yml` machinery (correction 2: no duplicate `evals.yml`).
5.4 [S] WHILE the golden set has fewer than 20 cases, THE PR gate SHALL run in report-only (non-blocking) mode; threshold-based merge blocking SHALL be enabled only after 5.1 is met.
5.5 [U] THE supervisor's document-generation SHALL gain an optional verification step: mechanical checks first (citation-reference existence, format conformance) in TS, an LLM verifier via `/eval/*` as opt-in; the default behavior SHALL be unchanged when unset (RV-7).
5.6 [U] THE LLM verifier SHALL receive only the artifact and acceptance criteria — never the doer's conversation history.
5.7 [E] WHEN verification fails, THE workflow SHALL emit a `JobEvent` using the closed vocabulary established by Req 1.4/1.5.

### Requirement 6: ガバナンス文書 — AgentOps ランブックと MCP ADR(Phase E / RV-5, RV-6, PL-4)

**User Story**: メンテナとして、運用の 3 本柱(可観測性・評価・最適化)と MCP の採用判断を
文書として固定したい。理由: 暗黙知のままでは将来の外部連携・モデル更新時に場当たりになるため。

**Acceptance Criteria**:

6.1 [U] `docs/agentops.md` SHALL map the three AgentOps pillars to this repo's implementations (OTel spans / audit log / Req 1.4 metrics; 3-tier + tier2 evals / Req 5 feedback loop; cost-latency-loop dashboards with thresholds), referencing unimplemented items by this spec's requirement IDs, and SHALL be reachable from CLAUDE.md.
6.2 [U] An ADR SHALL record the MCP position: non-adoption rationale, adoption criteria (>3 external SaaS tools / multi-host tool sharing / vendor MCP server decision), and the design principles fixed in advance — AI SDK v7 MCP client, a `needsApproval` ↔ MCP destructive-annotation mapping table (importing the sandbox NR-1 mapping), supply-chain vetting, and R5.2/R5.3 application to tool results.
6.3 [U] THE ADR SHALL reference the hybrid report's §5.1 threat model (tool-list exposure, action-class ambiguity, stdio credential exposure, stdio visibility gap) and §5.2 policy example as evaluation criteria for future MCP gateway placement.

## Non-Functional Requirements

NFR-1 [U] THE existing acceptance gates (`mise run check`, coverage ≥80%, `lint:model-ids`, git hooks, supply-chain guards) SHALL stay green throughout; every phase SHALL be landable independently without breaking them.
NFR-2 [U] `scripts/forbid-model-ids.sh` SHALL be extended to scan `services/**` `*.py` files with a carve-out for `services/agent/app/config.py` (correction 1 — extension of scan scope, not a mere exemption entry; existing TS carve-outs unchanged).
NFR-3 [U] THE Python service SHALL honor the R4.7 privacy contract: no raw question/answer/context bodies in access or application logs; sanitized identifiers only. Audit responsibilities stay with the TS callers' `deps.audit` (no second firing point).
NFR-4 [U] THE Python service SHALL NOT be exposed to browsers: callers are the nightly runner and the ingest CLI over an internal network with a service-to-service token; a JWT middleware requirement applies only if a future spec puts it on a user path.
NFR-5 [U] Python dependencies SHALL be uv-locked with `pip-audit` in a manual/CI stage, mirroring the intent of `allowBuilds`/`minimumReleaseAge` (audited, explicit supply-chain decisions).
NFR-6 [U] `JobEvent` extensions (Req 1.5, 5.7) SHALL be backward-compatible (optional fields) since `JobEvent` is an SSE wire contract.

## Traceability & Milestones

| 入力 | 対応要件 | フェーズ |
|---|---|---|
| RV-1(V-1: system 不在) | Req 1.1, 1.2, 1.8 | A |
| RV-2(V-2: 予算・停止理由) | Req 1.3–1.6 / NFR-6 | A |
| RV-3(V-3: コンテキスト方針) | Req 1.7 | A |
| PL-1(評価サイドカー)/ HR §1, §3.2 | Req 2, Req 3 | B, C |
| PL-2(取り込み強化)/ HR §1 | Req 4 | D |
| RV-4(V-4)+ PL-3 / HR §3.1, §3.3 | Req 5.1–5.4 | E |
| RV-7(V-7)/ HR §3.4 | Req 5.5–5.7 | E |
| RV-5(V-5) | Req 6.1 | E |
| RV-6(V-6)+ PL-4 / HR §5, sandbox NR-1 | Req 6.2, 6.3 | E |
| 検証補正 1(モデル ID ゲート) | NFR-2 | B |
| 検証補正 2(eval-nightly 既存) | Req 5.3 | E |

**着地順序と依存**(各フェーズは独立着地可能、NFR-1):

```
Phase A(Req 1)────────────── 先行・独立(RV 計画の P0/P1 に一致)
Phase B(Req 2)→ Phase C(Req 3)→ Phase E の 5.2/5.5(サービスが前提)
Phase B ──→ Phase D(Req 4。/parse はサービス骨格の上に載る)
Phase E の 5.1(golden set 拡充)──→ 5.4(ゲート有効化)
Req 6(文書のみ・独立。ただし 6.1 は Req 1.4 のメトリクス実装後が望ましい)
```

**マイルストーン Exit Criteria**(強化検討 §4 を要件 ID に写像):

- **M1(Phase A 完了)**: Req 1 の全基準 green。tier3 nightly の before/after 比較記録あり。
- **M2(Phase B+C 完了)**: `mise run py:check` green、契約ドリフトテストが CI で通過、
  nightly が忠実性/関連性スコアをケース毎に出力(non-blocking)。
- **M3(Phase D 完了)**: PDF コーパスを `--via-parser` で ingest → チャット引用に
  locator が表示される E2E が通過。既存 ingest 経路は byte 互換。
- **M4(Phase E 完了)**: golden set ≥20 件、閾値未達 PR がブロックされる。
  `docs/agentops.md` と MCP ADR が CLAUDE.md から到達可能。

## Out of Scope / Future Work

- **フルハイブリッド移行(旧 Phase C)**: 強化検討 §5 の採用条件(deep-research 型
  マルチエージェントの本線要件化 / 応答経路内 LlamaIndex クエリエンジンの実測必要性 /
  外部 SaaS 中心のツール群 + MCP 統合判断)のいずれかが成立した時点で、同 §5 の
  移行コスト台帳(system 写像・sticky taint 再実装・監査/承認/allowlist 移植・
  JWT 認証境界・決定論テストハーネス)を初期見積りとして別 spec を起こす。
- 再ランク(Cohere Rerank 等)・ハイブリッド/グラフ RAG(001 からの継続保留)。
- `@vaz/db` 分割、root-legacy テストの完全移行(001 の残課題)。
- Python サービスのコンテナ化・docker-compose 統合は Phase B では任意(ローカル uv 起動で
  可)。本番配備要件が出た時点で追補する。
