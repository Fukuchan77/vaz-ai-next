# 004-debt-closeout-refactor

## Project Description

003 クローズ直後(2026-07-24)、spec 001〜003 の全ドキュメント(spec/plan/tasks/gap-analysis/pdca)と
`docs/`(ADR・agentops・context-budget・spikes)を横断して、スコープ外・保留・申し送り項目を
**全件再検証**した。結果は 3 分類に整理できた:

1. **ドキュメントが現実と乖離** — 「保留」と記録されているが実際には解消済み。
   - `scripts/forbid-model-ids.sh` は既に `*.py` を走査し `services/agent/app/config.py`
     カーブアウトも実装済みだが、AGENTS.md は「`*.ts`/`*.tsx` のみ、将来拡張」と記載。
   - ingest CLI の bin スクリプト(`packages/rag/bin/ingest.ts` + `"ingest"` script)は実在するが、
     AGENTS.md は「bin スクリプト無し」と記載。
   - AGENTS.md の「Active Spec: 002-pydantic-enhance」セクション全体が stale
     (「system prompt 未配線」等、002/003 完了済みの事実と矛盾)。
   - `packages/tools/src/allowlist.ts` の docstring は「`createEmailCapability` への配線は
     後続タスクへ deferred」と主張するが、実際は `email.ts` が配送トランスポート前に
     `assertAllowedRecipient` を呼んでおり(allow/reject 両テスト有)、R5.4 ゲートは稼働中。
2. **トリガー無しで着手可能な実債務** — `@vaz/db` 分割(001 から 3 度繰延、003 が「独立 spec とする」
   と明記)、CI ゲート欠落(`lint:model-ids` と `py:check` がどの自動トリガーでも走らない、
   coverage 除外の `nightly.ts`/`pr-gate.ts` 非対称)、M3 locator E2E の既知バグ 2 件
   (003 が原因特定済みのまま 002 へ差し戻し)。
3. **トリガー待ちで保留継続が正しい項目** — full-hybrid 移行 / MCP 採用 / RAG 強化 /
   LlamaParse 実呼び出し / JWT・S2S / compaction Stage 2 等。トリガー条件は有効なまま未成立。

本 spec は分類 1・2 を消化し、分類 3 を「検証済みトリガー付き台帳」(Out of Scope / Future Work)
として確定コミットする。003 の「002 スコープ外 46 項目の棚卸し」を、コード実態との突合まで
含めて完結させるクローズアウト spec である。

## Clarifications

### Session 2026-07-24(棚卸しで確定済みの検証事実と設計判断)

- **R5.4 allowlist は配線済みと判明**: `packages/tools/src/email.ts` の `execute` が配送前に
  `assertAllowedRecipient(input.to, allowlist)` を呼び、`packages/tools/tests/email.spec.ts` が
  allow / reject(`RecipientNotAllowedError`)両経路をカバー。R4 は「配線実装」ではなく
  「追認 + stale docstring の是正」に縮小する。
- **`@vaz/db` のカット線は schema モジュール全体**: workflow テーブルのみの分割は
  `EMBEDDING_DIM`・drizzle-zod contracts の所有を 2 パッケージへ分裂させるため不採用。
  pool/`pg` は composition root(`packages/rag/bin/ingest.ts`, `apps/worker/src/start.ts`,
  `apps/web/src/lib/db.ts`)に残し、`@vaz/db` は schema-only とする。
- **絡まりは低いことを事前検証済み**: `@vaz/rag/db/schema` の本番 import は
  `apps/worker/src/stores.ts` の 1 箇所のみ(+テスト・`packages/rag` 内部)。`apps/web` は
  `@vaz/worker/src/stores` ポート層経由で絶縁されており直接 import は無い。
- **drizzle-kit は不採用のまま**: リポジトリに drizzle.config は存在せず、DDL は手動 `psql` 適用
  (003 pdca/do.md)。本 spec は既存 SQL(`0000_add_locator.sql`)の移動のみ行い、drizzle-kit
  採用は「次の DDL 変更」をトリガーとして台帳へ送る。
- **`python.yml` は `tests.yml` の `gate` に含めない**: path-filter 付きジョブは大半の push で
  不存在となり、`needs` + `if: always()` の required check 集約を壊す。また `py:check` を
  `mise run check` の外に置く既存スタンス(NFR-1: TS ゲートは Python toolchain 無しで green)
  と整合させ、可視化(CI 実行)のみを追加しブロッキング化はしない。
- **意図的設計 3 件は「保留」ではない**(台帳で除外判断として記録):
  (a) `data-processing` specialist の `SpecialistUnavailableError` throw は `options.specialists`
  override シーム前提の設計(supervisor.ts docstring 明記)。(b) `JobStore` の最小サーフェス
  (`insert` + `findOwnerUserId`)は approve/stream ルートの現需要を完全充足しており、呼び出し元の
  無い list/status-update メソッド追加は「既存シーム優先・新語彙を足さない」規約に反する。
  (c) `ADMIN_EMAILS` / `RECIPIENT_ALLOWLIST` の空出荷はコミット済み許可リストのガバナンス設計。
- **`pr-gate.ts` は単純 coverage 除外**: pure 関数(`computePrGateMetrics` 等)を別ファイルへ
  抽出する代替案はより綺麗だが diff が大きい。`nightly.ts` と同状況・同型の除外で対称性を取り、
  テスト自体(`tests/pr-gate.spec.ts`)は走り続ける。

## Scope

### In scope

- 保留項目台帳の確定 — 棚卸し結果・トリガー・除外判断・運用者アクション現況のコミット(R1)
- `@vaz/db` パッケージ分割 — 挙動変更ゼロのリファクタ(R2)
- ドキュメント整合 — 乖離 4 件の是正 + 002 レトロの steering 候補 4 件の取り込み(R3)
- R5.4 配線の追認と docstring 是正(R4)
- CI ゲート配線 — model-ID ゲート / `py:check` workflow / coverage 除外対称化(R5)
- M3 locator E2E 修正 — 002 申し送り 2 原因の消化(R6)
- (任意)sidecar の opt-in compose profile(R7)

### Out of scope

- トリガー待ちの大型案件すべて(「Out of Scope / Future Work」の台帳参照): full-hybrid 移行、
  MCP 採用、RAG 強化(再ランク・graph RAG・LlamaParse 実呼び出し)、JWT/S2S・本番コンテナ化、
  compaction Stage 2、per-step 検証ポリシー、Renovate/Dependabot、Grafana ダッシュボード、
  マルチテナント/SLA、Vision/マルチモーダル
- drizzle-kit の採用(トリガー: 次の DDL 変更)
- 運用者アクション 3 件の実施そのもの(台帳で現況記録のみ): `ANTHROPIC_API_KEY` Secret 追加、
  branch protection 作成、`sharp`/`postcss` override 撤去監視

## Glossary

- **棚卸し(inventory)**: spec 横断でスコープ外・保留・申し送り項目を収集しコード実態と突合する作業。
- **台帳(ledger)**: 保留継続項目をトリガー条件付きで記録した一覧。本 spec の Out of Scope /
  Future Work セクションがその正本。
- **クローズアウト**: 記録上「保留」だが実態は解消済み・または今すぐ解消可能な項目を消化し、
  残りを台帳化して保留リストをゼロベースへ戻すこと。
- **カット線**: パッケージ分割でどこまでを移動対象とするかの境界。

## Requirements

<!--
EARS 形式(rules/ears-format.md)。受入基準は階層番号で採番し plan.md / tasks.md の
トレーサビリティキーとする。既定主語 THE VAZ platform。
-->

### Requirement 1: 保留項目台帳の確定(棚卸しのコミット)

**User Story**: 保守者として、次の棚卸しで同じ項目を再調査せずに済むよう、保留項目の検証結果・
トリガー条件・除外判断を spec 本文として確定コミットしたい。理由: 003 の 46 項目棚卸しは
pdca 内の記録に留まり、「実は解消済み」の項目(R3/R4 が是正する乖離)を検出できていなかった。

**Acceptance Criteria**:

1.1 [U] 本 spec の「Out of Scope / Future Work」SHALL list every deferred item carried from 001–003 with its verified trigger condition(検証日付き)。
1.2 [U] 意図的設計 3 件(`data-processing` stub / `JobStore` 最小サーフェス / 空 allowlist 出荷)SHALL be recorded with their verification evidence として台帳に「保留ではない」旨を明記する(将来の棚卸しが再フラグしないため)。
1.3 [U] コード外の運用者アクション 3 件(`ANTHROPIC_API_KEY` Secret → eval 初観測、branch protection 新規作成、`sharp`/`postcss` override 撤去監視)SHALL be recorded with current status。

### Requirement 2: `@vaz/db` パッケージ分割

**User Story**: 保守者として、DB スキーマの置き場所を「`@vaz/rag` が Drizzle+pg を持っているから」
という歴史的経緯から切り離し、宣言どおりの `@vaz/db` に住まわせたい。理由: 001 Phase 3 から
schema.ts 自身の docstring が「later refactor」と予告したまま 3 spec 繰延されてきた。

**Acceptance Criteria**:

2.1 [U] `packages/db`(`@vaz/db`)SHALL host the whole schema module — RAG tables(`document`/`chunk`/`embedding`)、workflow tables(`job`/`jobEvent`/`auditLog`)、`EMBEDDING_DIM`、drizzle-zod contracts — and the `drizzle/` migration dir, following the source-only package conventions(`"exports": {"./*": "./src/*.ts"}`、build 無し、per-package tsconfig 無し)。
2.2 [U] `@vaz/db` の runtime code SHALL import no `@vaz/*` package(`@vaz/schemas` と並ぶ第 2 のリーフ。`@vaz/schemas` はテスト専用 devDependency のみ)。`pg` は依存に含めない(pool は composition root 所有)。
2.3 [U] すべての `@vaz/rag/db/schema` import SHALL be rewritten to `@vaz/db/schema`、and `@vaz/rag` SHALL no longer contain `src/db/`(再 export シムは置かないクリーンカット)。
2.4 [U] package 依存 SHALL be updated to the honest graph: `@vaz/rag` +`@vaz/db` −`drizzle-zod`(schema.ts が唯一の利用者だった)、`apps/worker` は `@vaz/rag` → `@vaz/db` 置換(stores.ts が唯一の rag import だった)、`@vaz/evals` +`@vaz/db`、`@vaz/agents` devDeps +`@vaz/db`(テストのみ)。
2.5 [U] 分割は挙動変更ゼロ: 全ユニットテスト green・coverage 閾値(lines/functions ≥ 80)維持・`pnpm audit` 0 件・DDL/SQL 内容は無変更(ファイル移動のみ)。
2.6 [U] AGENTS.md / CLAUDE.md の dep-graph・パッケージ一覧・スキーマ所在の記述 SHALL be updated in the same change(6→7 packages、`@vaz/db` 節の新設、「future refactor」文言の削除)。

### Requirement 3: ドキュメント整合(steering 同期)

**User Story**: エージェント・開発者として、AGENTS.md/CLAUDE.md を読んだ時に現実のコードと
矛盾しない指針を得たい。理由: 棚卸しで「保留と記録されているが解消済み」の乖離が 4 件確認された。

**Acceptance Criteria**:

3.1 [U] AGENTS.md の「Active Spec: 002-pydantic-enhance」セクション SHALL be rewritten as a permanent「Python sidecar(`services/agent`)」section — stale な進行中表現(「system prompt 未配線」「NFR-2 will be extended」)を排し、恒久不変条件(stateless / 境界契約 / 単一ライター / model-ID ゲートの Python 適用済み / `py:check` / `openapi:gen`)のみを残す。
3.2 [U] ingest CLI の記述 SHALL reflect the existing bin script(`pnpm --filter @vaz/rag ingest <path>`、`--via-parser` は拡張子フィルタ無し)。
3.3 [U] 002 レトロ(`pdca/act-final.md` Learnings→Rules 表)の steering 候補 4 件 — 言語境界契約パターン(余剰フィールドの落とし穴含む)/ 既存シーム優先・型で不変条件保証 / フェーズ毎 adversarial-review / `_Boundary:_` 周辺ファイル先回り — SHALL be folded into AGENTS.md Non-Obvious Patterns。
3.4 [U] CLAUDE.md のミラー記述(パッケージ数・dep graph)SHALL be updated consistently(CLAUDE.md は `@AGENTS.md` を inline するため、CLAUDE.md 固有文のみ)。

### Requirement 4: R5.4 配線の追認と docstring 是正

**User Story**: セキュリティレビュアーとして、「破壊的ツールの独立 2 制御」の片方(recipient
allow-list)が稼働しているか否かをコードコメントから誤認したくない。

**Acceptance Criteria**:

4.1 [U] 検証記録: `packages/tools/src/email.ts` の `execute` SHALL call `assertAllowedRecipient` before the delivery transport、and `packages/tools/tests/email.spec.ts` SHALL cover both allow and reject(`RecipientNotAllowedError`)paths(棚卸し時点で既に真 — 追認)。
4.2 [U] `packages/tools/src/allowlist.ts` の docstring SHALL state the wiring is complete(「deferred to the task that owns that file's edit boundary」文言の削除)。

### Requirement 5: CI ゲート配線

**User Story**: 保守者として、宣言済みの品質ゲートが自動トリガーで実際に走ってほしい。理由:
`lint:model-ids` は `mise run check` の手動実行時のみ、`py:check` はどの CI でも走っておらず、
ゲートの存在がドキュメント上の宣言に留まっていた。

**Acceptance Criteria**:

5.1 [U] `.github/workflows/lint.yml` SHALL run `scripts/forbid-model-ids.sh`(checkout 直後・install 不要の fail-fast 配置)。
5.2 [U] `.githooks/pre-commit` SHALL run `mise run lint:model-ids` as step 5/5、and its header comment SHALL no longer claim the gate is `mise run check`-only。
5.3 [U] 新設 `.github/workflows/python.yml` SHALL run `mise run py:check` path-filtered on `services/agent/**`(+`mise.toml`+自 workflow)。`mise.toml` `[tools]` SHALL pin `uv` so local and CI provision the same。本 workflow は `tests.yml` の `gate` 集約に SHALL NOT be added(Clarifications 参照)。
5.4 [U] `vitest.config.ts` coverage SHALL exclude `packages/evals/src/pr-gate.ts` with a comment mirroring the `nightly.ts` exclusion、and thresholds(lines/functions ≥ 80)SHALL keep passing。

### Requirement 6: M3 locator E2E 修正(002 申し送りの消化)

**User Story**: 開発者として、ローカルスタックで `mise run test:e2e:ollama` を走らせた時に、
003 が特定済みの 2 原因で locator 引用 E2E が落ちない状態にしたい。

**Acceptance Criteria**:

6.1 [U] `getByText("You")` SHALL use `{ exact: true }` in all three e2e specs(`locator-citation` / `chat-ollama` / `chat-anthropic`)— 応答本文に部分文字列 "You" が含まれると strict-mode 曖昧一致で fail するため(003 pdca/check.md 記録の原因 (a))。
6.2 [U] 合成 PDF の `DISTINCTIVE_FACT` SHALL place a sacrificial sentence after the codename so Docling の行末 OCR 欠落(原因 (b): `19.` 喪失)がセンチネルを食い、検証対象の事実は保全される。アサーション(`CODENAME` / `"locator"`)は無変更。
6.3 [E] WHEN ローカルスタック(docker compose + Ollama + `services/agent`)が到達可能な環境で実行された時, `mise run test:e2e:ollama` の結果 SHALL be recorded in pdca/check.md(本 spec の実装環境で到達不能な場合は honest-skip として記録し、実走はローカル/CI 追跡へ委譲)。

### Requirement 7(任意): sidecar の opt-in compose profile

**User Story**: 開発者として、locator E2E・`--via-parser`・tier2 evals のために `services/agent` を
1 コマンドで立ち上げたい。ただし既定の `docker compose up -d` は重くしたくない。

**Acceptance Criteria**:

7.1 [S] WHILE 本番コンテナ化が保留の間, `docker-compose.yml` MAY provide a `sidecar` service behind `profiles: ["sidecar"]`(uv ベースの `services/agent/Dockerfile`)— 既定の `docker compose up -d` は影響を受けない(Docling→torch でイメージが重いため opt-in)。
7.2 [S] 併記: bare-metal 起動(`uv run uvicorn app.main:app --port 8000`)は引き続き第一級の起動手段である(compose profile はその代替であり置換ではない)。

### NFR

- **NFR-1**: R1〜R7 は互いに独立して着地可能(R2 を先頭にするのは推奨順序であって依存ではない)。
- **NFR-2**: R2 は refactor-only — DDL 変更なし、drizzle-zod contract 変更なし、実行時挙動変更なし。
- **NFR-3**: 全フェーズを通じ既存ゲート(biome / tsc / vitest / audit / lint:model-ids)green を維持。
  `py:check` の対象コードは無変更(R7 の Dockerfile は Python コード外)。

## Traceability & Milestones

| Milestone | Requirements | 主担当ファイル |
| --- | --- | --- |
| M1: `@vaz/db` 分割 | R2 | `packages/db/*`, `packages/rag/*`, `apps/worker/*`, 各 package.json |
| M2: CI ゲート配線 | R5 | `.github/workflows/lint.yml`, `python.yml`(新), `.githooks/pre-commit`, `mise.toml`, `vitest.config.ts` |
| M3: ドキュメント整合 | R3, R4 | `AGENTS.md`, `CLAUDE.md`, `packages/tools/src/allowlist.ts` |
| M4: E2E 修正 + compose | R6, R7 | `apps/web/tests/e2e/*.spec.ts`, `services/agent/Dockerfile`, `docker-compose.yml` |
| M5: 台帳確定 | R1 | 本ファイル + pdca |

## Out of Scope / Future Work(保留項目台帳 — 検証日 2026-07-24)

### A. トリガー待ち(005+ 候補。トリガー成立まで着手しない)

1. **full-hybrid 移行(Pydantic AI + `VercelAIAdapter` 本線化)** — トリガー(いずれか 1 つ):
   (a) deep-research 型 multi-agent の本線要件化、(b) 応答経路内 LlamaIndex query engine の実測必要性、
   (c) 外部 SaaS 中心ツール群 + MCP 統合判断。起票時は 002 spec.md の移行コスト台帳
   (system 写像・sticky taint 再実装・監査/承認/allowlist 移植・JWT 認証境界・決定論テストハーネス)
   を初期見積りに使う。
2. **MCP 採用** — トリガー: `docs/adr/0001-mcp-position.md` の 3 基準いずれか(外部 SaaS ツール
   3 超 / 複数ホストでのツール共有 / ベンダ提供 MCP サーバ利用の決定)。設計原則は ADR 確定済み。
   注: ADR が参照する Hybrid Report [HR] は未コミット — gateway spec 起票時に要取得。
3. **観測性/最適化(Grafana ダッシュボード・cost/latency 閾値アラート・`CHAT_TOKEN_BUDGET`
   実測再チューニング)** — 起票時は 002 Req 5.3/6.1 にスコープする(`docs/agentops.md` §1/§3)。
4. **コンテキスト自動 compaction(Stage 2)** — トリガー: `budget-exceeded` が stop_reason の
   支配的要因になること。挿入点は実装済みの Stage 1 `prepareStep` シーム(`docs/context-budget.md`)。
5. **RAG 強化** — 再ランク(Cohere Rerank 等)・ハイブリッド/グラフ RAG(001 からの継続保留)、
   LlamaParse 実呼び出し(現状 `POST /parse` は `use_llamaparse=true` で 501。トリガー: 機密文書の
   外部送信可否の運用判断)。
6. **プラットフォーム/配備** — 本番コンテナ化(R7 の dev profile はこれを代替しない)、S2S トークン
   発行/検証、JWT ミドルウェア。トリガー: 本番配備要件、または Python サービスのユーザー到達
   パス昇格。
7. **per-step 検証ポリシー** — トリガー: 複数 doc-gen ステップで異なる `acceptanceCriteria`/`llmVerify`
   の使い分けニーズ(`SpecialistInput` document-generation バリアント拡張)。
8. **Renovate/Dependabot 導入** — 採否基準は `docs/dependency-policy.md` に記録済み。導入判断は別途。
9. **drizzle-kit 採用** — トリガー: 次の DDL 変更(現状 DDL は手動 `psql` 適用、SQL は
   `packages/db/drizzle/`)。
10. **001 由来の未着手系** — 本番課金最適化・マルチテナント・SLA 設計 / Vision・マルチモーダル入力 /
    実 IdP テナントでの OAuth 実ラウンドトリップ(トリガー: 到達可能なテナント)。

### B. 意図的設計(保留ではない — 再フラグ禁止の検証記録)

- **`data-processing` specialist の throw**(`packages/agents/src/supervisor.ts`): `operation`
  ペイロードはアプリ定義のため汎用デフォルトは存在せず、`options.specialists` override が
  正規の差し替えシーム。docstring 明記済み。実装を「忘れている」のではない。
- **`JobStore` の最小サーフェス**(`apps/worker/src/stores.ts`: `insert` + `findOwnerUserId`):
  approve/stream ルートの現需要を完全充足。list/status-update は呼び出し元が存在せず、追加は
  「既存シーム優先」規約違反。トリガー: ジョブ履歴/管理 UI 要件、または completed/failed の
  DB 区別を要する運用需要。
- **空 allowlist 出荷**(`ADMIN_EMAILS` / `RECIPIENT_ALLOWLIST`): コミット済み許可リストの
  ガバナンス設計(エントリ追加はレビュー済みコード変更、env 不可)。R4 で配線稼働も追認済み。

### C. 運用者アクション(コード外 — 現況 2026-07-24)

1. **`ANTHROPIC_API_KEY` を リポジトリ Secrets へ追加** → 次回 PR で `eval-pr.yml` の閾値ブロック
   遷移(002 Req 5.4 初回観測)、nightly の tier1/tier3 verdict 実観測(003 R5.1/5.3 申し送り解消)。
   現況: 未実施(eval workflows は Secret 不在時 skip)。
2. **branch protection の新規作成**(`gate` を唯一の required check に) — 003 の申し送り。
   現況: 未実施(`gate` が CI で 1 度 green になった後に `gh api .../branches/main/protection -X PUT`)。
3. **override 撤去監視**: `sharp@<0.35.0` は next stable が 0.35 系依存へ更新された時点で撤去
   (`docs/dependency-policy.md` 撤去条件表 + `pnpm-workspace.yaml` コメントの両方を更新)。
   `postcss@<8.5.10` は `next` の依存範囲更新で自然解消後に撤去。
