# 003-dependency-security-hardening

## Project Description

2026-07-22 以降、CI の `tests` ワークフロー(`.github/workflows/tests.yml`)が Security Audit
ステップ(`pnpm audit --audit-level=moderate`)で失敗し続けた。原因調査(2026-07-24)の結果、
コード変更起因ではなく、**2026-07-20〜21 に公開された依存パッケージの新 advisory 19 件**
(critical 3 / high 9 / moderate 7)によるものと確定した。

| パッケージ | 脆弱版 | 修正版 | 経路 |
| --- | --- | --- | --- |
| `next` | 16.2.10 | 16.2.11 | `apps/web` 直接依存(9 advisory) |
| `next-auth` / `@auth/core` | 5.0.0-beta.31 / 0.41.2 | 5.0.0-beta.32 / 0.41.3 | `apps/web` 直接依存(8 advisory) |
| `sharp` | 0.34.5 | 0.35.0+ | `next` の推移的 optional 依存。**next 16.2.11 の依存範囲 `^0.34.5` は修正版を含まない** |
| `js-yaml` | 4.2.0 | 4.3.0 | `openapi-typescript>@redocly/openapi-core`(dev-only) |
| `brace-expansion` | 2.1.1 | 2.1.2 | 同上 `>minimatch`(dev-only) |

止血(依存バンプ + `pnpm-workspace.yaml` overrides 3 件追加)は本 spec の起票と同一ブランチで
実施済み(`pnpm audit` 0 件、`mise run check` 相当 + `next build` green を確認)。

この事象は 002 の `pdca/act-final.md`(「Next.js/sharp CVE と NODE_ENV build quirk を
**依存更新 spec として切り出す**」)が予告していた技術負債の現実化である。本 spec は
(1) この止血の追認と **advisory 対応の恒常運用化**、(2) audit ゲートの回復可能性設計、
(3) `NODE_ENV` build quirk の恒久対処、(4) 002 の PDCA が積み残した小粒ハードニング、を扱う。

002 のスコープ外事項 46 項目の棚卸し(2026-07-24)のうち、トリガー待ちの大型案件は本 spec に
**含めず**、「Out of Scope / Future Work」に 004+ 候補としてトリガー条件付きで整理する。

## Clarifications

### Session 2026-07-24(調査で確定済みの設計判断)

- **sharp は override で対処**: next stable の依存範囲(`^0.34.5`)が修正版 0.35.0 を含まない
  一方、next canary は既に `^0.35.3` を採用しており、override は upstream 方向と整合する。
  next stable が 0.35 系を取り込んだ時点で override を撤去する(R1.4)。
- **`minimumReleaseAge: 1440` は維持**: 今回の全修正版はリリース 24h 超経過で抵触しなかった。
  抵触するケース(公開直後のパッチ)は既存の `minimumReleaseAgeExclude` を個別・期限付きで使う。
- **audit の一時許容は `auditConfig.ignoreGhsas`**: 修正版が存在しない advisory で CI 全体が
  止まる事態に備える。`allowBuilds` と同じ「コミットされた監査済み決定」パターンに従い、
  env や CI 設定での抑止は行わない(R2)。
- **NODE_ENV quirk はコード修正ではなくビルドパス固定**: 原因は特定済み
  (`apps/web/src/app/global-error.tsx` の NOTE 参照 — 非標準 `NODE_ENV` での `next build` 時のみ
  `/_global-error` prerender が失敗)。`next build` 実行経路で `NODE_ENV=production` を明示する(R3)。
- **`main` の branch protection は現状ゼロ**: `gh api repos/:owner/:repo/branches/main/protection` は
  `404 Branch not protected`、`rulesets` も空(2026-07-24 確認)。R2.2 は「既存 required check の
  緩和ではない」ことの根拠として「現行 `unit` 単体が required」という想定を用いていたが、実際には
  **現時点でどのジョブも required になっていない**。R2 の完了条件は「既存設定の置き換え」ではなく
  「branch protection の新規作成」である(R2.2 に反映)。
- **`gate` の対象範囲に既存 `e2e` ジョブを含める**: `.github/workflows/tests.yml` には `unit`/`e2e` の
  2 ジョブが存在し、`e2e` は本 spec の R3.2(Build ステップの `NODE_ENV`)対象でもある。branch
  protection を新規作成する機会に、required check を単一の `gate` に集約し `unit`/`audit`/`e2e`
  すべての結果を包含する(R2.2 に反映)。
- **`pnpm-workspace.yaml` の `postcss@<8.5.10` override は本 spec の対象外**: 先行 spec 由来
  (GHSA-qx2v-qp2m-jg93、`next` が固定する `postcss` 8.4.31 の XSS)であり、本 spec が起票した
  19 advisory には含まれない。撤去条件は override コメントに既記のため、本 spec では
  「維持のみ・新規判断は行わない」を明文化する(R1.2 の追認範囲に含む)。

## Scope

### In scope

- 依存 advisory 対応の追認と恒常運用(R1)
- Security Audit ゲートの回復可能性・CI ジョブ構造(R2)
- `NODE_ENV` build quirk の恒久対処(R3)
- 002 積み残しの小粒ハードニング: bare `assert` 排除、`total_tokens` 境界定義、
  Req 2.7b 所管の 002 spec 本文への明文化(R4)
- 002 の運用上の未実施確認 3 件の完了(R5): Req 1.8 nightly before/after、M3 locator E2E、
  Req 5.4 閾値ブロック遷移の初回観測

### Out of scope

- full-hybrid 移行 / MCP 採用 / 観測性ダッシュボード / compaction Stage 2 / RAG 強化 /
  コンテナ化・S2S / `@vaz/db` 分割(「Out of Scope / Future Work」参照)
- Renovate/Dependabot 等の自動依存更新ボットの導入(R1.5 で採否判断のみ記録し、導入は別途)

## Glossary

- **advisory**: GitHub Advisory Database に登録された脆弱性情報(GHSA ID で識別)。
- **override**: `pnpm-workspace.yaml` `overrides` による推移的依存の解決強制。
- **ignoreGhsas**: pnpm `auditConfig.ignoreGhsas` — audit から特定 GHSA を除外する設定。
- **NODE_ENV build quirk**: 非標準 `NODE_ENV` 下の `next build` で `/_global-error` prerender が
  失敗する既知事象(002 `pdca/check-final.md` 検出、pre-existing)。

## Requirements

<!--
EARS 形式(rules/ears-format.md)。受入基準は階層番号で採番し plan.md / tasks.md の
トレーサビリティキーとする。既定主語 THE VAZ platform。
-->

### Requirement 1: 依存 advisory 対応の追認と恒常運用

**User Story**: 運用者として、advisory 起因の CI 失敗を「原因調査→最小パッチ→検証」の
定型手順で解消でき、overrides の撤去条件が追跡可能であってほしい。理由: 今回のように
コード変更なしで CI が赤くなる事象は再発が確実で、都度アドホックに対応すると
pre-commit フック(audit 内蔵)がローカル開発も止めるため。

**Acceptance Criteria**:

1.1 [U] `apps/web/package.json` SHALL declare `next` ≥ 16.2.11 and `next-auth` = 5.0.0-beta.32, and `pnpm audit --audit-level=moderate` SHALL exit 0 on the lockfile(止血の追認。実施済み)。
1.2 [U] `pnpm-workspace.yaml` の各 override SHALL に対象 GHSA ID・理由・撤去条件をコメントで併記する(実施済み分の維持 + 以後の追加規約)。
1.3 [U] `docs/dependency-policy.md` SHALL document the advisory-response runbook: 検知(CI 失敗)→ `pnpm audit --json` での棚卸し → 直接依存バンプ / 範囲内 lockfile 更新 / override / `ignoreGhsas` の選択基準 → 検証手順(`mise run check` + `build`)→ `minimumReleaseAge` との関係。
1.4 [E] WHEN next stable の `sharp` 依存範囲が `>=0.35.0` を含む版へ更新された時, THE maintainer SHALL remove the `sharp@<0.35.0` override(撤去条件の追跡は 1.3 の runbook に記載)。
1.5 [S] WHILE 自動依存更新ボット未導入の間, `docs/dependency-policy.md` SHALL record the adoption criteria for Renovate/Dependabot(`minimumReleaseAge`・`allowBuilds` との整合条件を含む)。

### Requirement 2: Security Audit ゲートの回復可能性と CI 構造

**User Story**: 開発者として、advisory 起因の audit 失敗があってもユニットテストの結果は
見えてほしく、修正版が存在しない advisory では監査済みの一時許容ができてほしい。
理由: 現状は `unit` ジョブ内の直列ステップのため、audit が落ちるとテストが実行されず
無関係な push まで実質ブロックされる。

**Acceptance Criteria**:

2.1 [U] `.github/workflows/tests.yml` SHALL run the Security Audit as a job independent of `unit`(audit 失敗時もユニットテスト結果が可視である)。
2.2 [U] `unit`・`audit`・`e2e` ジョブの結果を集約する `gate` ジョブ SHALL be configured as the sole required status check on `main` via newly-created branch protection(現状 `main` に branch protection は存在せず — `gh api .../branches/main/protection` は 404 —、本要件は既存 required check の緩和ではなく新規作成である。ジョブの分離自体は可視性のためであり、失格基準の緩和ではない)。
2.3 [E] WHEN 修正版が存在しない・または `minimumReleaseAge` 未達の advisory で audit が失敗した時, THE maintainer SHALL be able to add the GHSA to `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` with a comment stating (a) GHSA ID の内容、(b) 除外理由、(c) 再評価期限。エントリは committed code change としてレビューを経る(env・CI 変数での抑止は行わない)。
2.4 [U] `docs/dependency-policy.md`(1.3)SHALL state that `ignoreGhsas` entries are temporary and reviewed at each PR touching `pnpm-workspace.yaml`, and stale entries(再評価期限超過)are treated as lint-comparable debt。

### Requirement 3: `NODE_ENV` build quirk の恒久対処

**User Story**: 開発者として、`mise run build` がシェル環境の `NODE_ENV` に依存せず
再現可能に成功してほしい。理由: 002 の check-final で「非標準 `NODE_ENV` 時のみ
`/_global-error` prerender が失敗」が pre-existing 事象として検出され、要別追跡とされた。

**Acceptance Criteria**:

3.1 [U] `mise.toml` の `build` タスク SHALL set `NODE_ENV=production` explicitly(シェル継承値に依存しない)。
3.2 [U] CI の E2E `Build` ステップ(`pnpm --filter @vaz/web run build`)SHALL set `NODE_ENV=production` explicitly in the step's `env`(既定挙動への依存を排し、シェル・runner の継承値に関わらず再現させる)。
3.3 [U] `apps/web/src/app/global-error.tsx` の NOTE コメント SHALL be updated to point at the enforced build path(回避策の知識をコメント内に閉じ込めない)。

### Requirement 4: 002 積み残しの小粒ハードニング

**User Story**: 保守者として、`python -O` で無効化される検査や曖昧なトークン集計の
境界定義を解消し、002 の PDCA が「次回タスクで」とした宿題を消化したい。

**Acceptance Criteria**:

4.1 [U] `services/agent/app/routes/eval.py`(現 49 行・67 行)の bare `assert` SHALL be replaced with an explicit `RuntimeError`(`python -O` でも検査が残る)、既存テストは green を維持する。
4.2 [U] `services/agent/app/eval/llama.py` の `to_token_usage` SHALL either use provider-reported `usage.total_tokens` or keep the recomputation with a boundary-definition comment stating why(cache/reasoning トークン扱いの決定を記録)。採った側の決定を docstring に明記する。
4.3 [U] 002 の `spec.md` または `tasks.md` SHALL be amended to record "Req 2.7b(traced_span の配線)は Phase E 所管" の判断(将来の Check が未実装と誤検出しないため。002 `pdca/act-phaseB.md` の指摘の恒久化)。

### Requirement 5: 002 の運用上の未実施確認の完了

**User Story**: 運用者として、002 が「実施のみ残」とした検証 3 件を完了させ、
002 のクローズ条件を満たしたい。

**Acceptance Criteria**:

5.1 [E] WHEN 本 spec の変更が PR になった時, THE maintainer SHALL observe and record `eval-pr.yml` の閾値ブロック判定への遷移(002 Req 5.4 の初回観測。golden set が 20 件に達し report-only は解除済み)。
5.2 [U] `mise run test:e2e:ollama`(docker compose + Ollama)による M3 locator 引用 E2E SHALL be run once and the result recorded in 本 spec の PDCA(002 act-final の PENDING 解消)。
5.3 [X] IF 依存バンプ後の nightly eval で tier1/tier3 の verdict が変化した場合, THEN a before/after comparison SHALL be recorded(002 Req 1.8 の運用の適用)。

## Non-Functional Requirements

- **NFR-1**: 本 spec のタスクは相互独立に着地可能とする(R1 止血は実施済み、R2〜R5 は任意順)。
  tasks.md の Task2→Task3 の記載順は runbook の選択基準を参照する推奨順であり、
  着手のブロッキング依存ではない。
- **NFR-2**: `pnpm-workspace.yaml` への変更(overrides / ignoreGhsas / allowBuilds)はすべて
  コメント付きの committed change とし、env・CI 変数での等価設定を導入しない。
- **NFR-3**: R4 の Python 変更は `mise run py:check`(uv sync + ruff + pyright + pytest)green を維持する。

## Traceability & Milestones

| Milestone | Requirements | 検証 |
| --- | --- | --- |
| M1: 止血追認(実施済み) | 1.1, 1.2 | `pnpm audit` 0 件・`check` 相当 green・`next build` 成功 |
| M2: ゲート再設計 | 2.1–2.4, 1.3–1.5 | audit 独立ジョブで CI green、`gate` を required check として branch protection を新規作成、runbook レビュー |
| M3: build 再現性 | 3.1–3.3 | `NODE_ENV` 未設定シェルから `mise run build` 成功 |
| M4: ハードニング | 4.1–4.3 | `py:check` green、002 spec 追記のレビュー |
| M5: 運用確認 | 5.1–5.3 | PDCA 記録 |

## Out of Scope / Future Work(004+ 候補)

002 スコープ外事項の棚卸し(46 項目)より、トリガー条件付きで保留する大型案件:

- **full-hybrid 移行(Pydantic AI + `VercelAIAdapter` 本線化)** — トリガー: 002 `spec.md`
  「Out of Scope / Future Work」の 3 条件(deep-research 型 multi-agent の本線要件化 /
  応答経路内 LlamaIndex query engine の実測必要性 / 外部 SaaS 中心ツールセット + MCP 判断)の
  いずれか成立。成立時は移行コスト台帳(強化検討 §5)を初期見積りに使う。
- **MCP 採用** — トリガー: `docs/adr/0001-mcp-position.md` の採用基準 3 条件(外部 SaaS ツール
  3 超 / 複数ホスト共有 / ベンダー提供 MCP server の利用決定)。設計原則は ADR に確定済み。
  注: ADR が参照する Hybrid Report [HR] は未コミット(gateway spec 起票時に要取得)。
- **観測性・最適化** — `docs/agentops.md` §1/§3 の未実装(Grafana ダッシュボード、コスト/
  レイテンシ閾値アラート、`CHAT_TOKEN_BUDGET` の実測再調整)。起票時は 002 Req 5.3/6.1 に
  スコープを当てる。
- **コンテキスト自動 compaction(Stage 2)** — `docs/context-budget.md` の段階計画。トリガー:
  `budget-exceeded` が stop_reason の支配的要因になった時。Stage 1 の `prepareStep` seam が挿入点。
- **RAG 強化** — re-ranking / hybrid・graph RAG(001 からの継続保留)、LlamaParse 実呼び出し
  (現状 501。機密文書の外部送信可否という運用判断が先行)。
- **プラットフォーム/配備** — Python service のコンテナ化・compose 統合、S2S トークン発行/検証、
  JWT ミドルウェア(トリガー: 本番配備要件、またはユーザー到達経路への昇格)。
- **`@vaz/db` 分割・root-legacy テスト完全移行** — 001 残課題。規模が大きく独立 spec とする。
- **per-step 検証ポリシー**(`SpecialistInput` document-generation variant 拡張)— トリガー:
  doc-gen step ごとに異なる `acceptanceCriteria`/`llmVerify` が必要になった時。
