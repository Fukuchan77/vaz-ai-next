# PDCA — Do Phase

散文は日本語、識別子・パス・コードは英語（`spec.json` `language: ja`）。

## Task 2: advisory 対応 runbook の新設

- **実施日**: 2026-07-24
- **Boundary**: `docs/dependency-policy.md`, `AGENTS.md`
- **Requirements**: 1.3, 1.4, 1.5, 2.3, 2.4, NFR-2

### 実施内容

- `docs/dependency-policy.md` を新設。構成: 対象 → 検知 → 棚卸し(`pnpm audit --json`)→
  対応 4 段階の選択基準(直接バンプ / 範囲内 lockfile 更新 / override / `ignoreGhsas`、
  各手段の適用条件を表で整理)→ 検証手順(`pnpm install` → `mise run check` →
  `NODE_ENV=production mise run build` の順、順序に意味がある旨を明記)→
  `minimumReleaseAge`/`minimumReleaseAgeExclude` との関係 → override/ignoreGhsas の
  撤去条件表(既存 4 件: `postcss`/`sharp`/`js-yaml`/`brace-expansion`)→ `ignoreGhsas` の
  書式例(a: advisory 内容, b: 除外理由, c: 再評価期限)と運用ルール(PR ごとレビュー、
  期限超過は debt 扱い)→ Renovate/Dependabot 採否基準(`minimumReleaseAge`/`allowBuilds`
  整合条件、採用トリガー)。
- `AGENTS.md` の「Supply chain gate」項に `docs/dependency-policy.md` へのリンクを追記
  (既存文の末尾に 1 文を追加する最小差分)。

### TDD について(このタスクに限り適用外)

Task 2 はアプリケーションコード・振る舞いの変更を含まない(運用文書の新設 + 既存文書への
1 文追記のみ)。テスト対象となるロジックが存在しないため RED→GREEN→REFACTOR は適用せず、
代わりに既存の集約ゲート(`mise run check`)が新設ファイルによって破壊されていないことを
検証ステップとして実行した(下記 VERIFY)。

### VERIFY

```sh
mise run lint   # pnpm exec biome check .
# → Checked 138 files in 92ms. No fixes applied.

mise run check  # lint + typecheck + test:run + audit + lint:model-ids
# → lint: Checked 138 files, no fixes applied
# → typecheck: apps/web / apps/worker / packages/evals すべて Done
# → test:run: Test Files 54 passed (54), Tests 560 passed (560)
# → audit: No known vulnerabilities found
# → lint:model-ids: ✅ No hardcoded model IDs found
```

全ゲート green。新設 Markdown ファイルは Biome の対象拡張子外だが、`AGENTS.md` への 1 文追記が
既存の Biome チェック(Markdown は対象外、他ファイルへの副作用なし)に影響しないことも
`mise run lint` で確認済み。

### 学び

- 本 spec の Task 2/4/5/6 のように「運用文書の新設」「コメント追記」だけのタスクは、
  TDD の RED フェーズが空になる。今後同種タスクでは「テスト対象コードが存在しない」ことを
  明示した上で、既存の集約ゲートを検証手段として採用するのが妥当(コードのないタスクに
  無理に unit test を書かない)。
- `docs/dependency-policy.md` の撤去条件表は `pnpm-workspace.yaml` のコメントと**内容が
  重複**する構造になった。単一正本は `pnpm-workspace.yaml`(NFR-2 に忠実)、runbook 側は
  「参照・要約」として位置づけ、将来 override を撤去する際は両方(コメント削除 + 撤去条件表の
  該当行更新)を更新する必要がある点を Task 3 以降の作業者への留意点として記録する。

## Task 3: Security Audit の独立ジョブ化

- **実施日**: 2026-07-24
- **Boundary**: `.github/workflows/tests.yml`
- **Requirements**: 2.1, 2.2, NFR-2

### 実施内容

- 3.1: `unit` ジョブから `Security Audit` ステップを除去し、独立 `audit` ジョブ
  (checkout → mise-action → pnpm-setup → `pnpm install --frozen-lockfile` →
  `pnpm audit --audit-level=moderate`)を新設。`unit`/`audit`/`e2e` はいずれも `needs` を
  持たず並列・独立のまま(audit 失敗時も unit/e2e の可視性を壊さない)。
- 3.2: `needs: [unit, audit, e2e]` + `if: always()` の集約 `gate` ジョブを追加。シェルで
  3 ジョブそれぞれの `result` を比較し、いずれかが `success` 以外なら `exit 1`
  (`needs.*.result` のオブジェクトフィルタ構文は `needs` がジョブ ID キーのマップであり
  配列ではないため不成立と判断し、明示的な文字列比較を採用)。

### TDD の適用(YAML 構造検証として実施)

`.github/workflows/tests.yml` はアプリケーションコードではないため Vitest 等のテスト
ランナーの対象外(既存リポジトリに workflow YAML を検証する test ファイルは存在しない)。
代わりに `services/agent/.venv` の PyYAML を用いた構造検証スクリプトで RED→GREEN を実施した
(新規の永続テストファイルは追加しない — CI YAML 用の使い捨て検証)。

**RED**(変更前、期待する構造が存在しないことを確認):

```
jobs: ['unit', 'e2e']
has audit job: False
has gate job: False
```

**GREEN**(変更後、要件を満たす構造になったことを確認):

```
PASS: jobs are unit/audit/e2e/gate
PASS: unit has no Security Audit step
PASS: unit still runs Test step
PASS: unit has no needs (independent)
PASS: audit steps: ['Install Dependencies', 'Security Audit']
PASS: audit has no needs (independent)
PASS: e2e has no needs (independent)
PASS: gate needs unit/audit/e2e
PASS: gate has if: always()
PASS: gate step contains exit 1 on failure
```

### Branch protection(3.2 の required-check 新規作成)について

`gh api repos/:owner/:repo/branches/main/protection` は本タスク開始時点でも `404 Branch not
protected`(2026-07-24 再確認、`rulesets` API も空)。plan.md の fallback 手順に従い、
**このセッションでは branch protection を新規作成しない**ことをユーザーに確認し、承認を得た
(理由: `gate` という名前のチェックが CI 上で一度も走っていない状態で required context に
指定すると GitHub 側の認識が遅れる可能性があるため、まず本 PR で `gate` を実走させてから
運用者が作成するのが安全)。

**運用者向け手順(PR 説明に転記する)**:

```sh
gh api repos/Fukuchan77/vaz-ai-next/branches/main/protection \
  -X PUT --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "checks": [{ "context": "gate" }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

本 PR がマージされ `gate` ジョブが最低 1 回実行された後に、上記コマンドで required check を
新規作成する。作成が完了するまでは(本 PR 含め)**どのジョブもマージをブロックしていない**
(既存 required 設定の一時後退ではなく、未設定状態の継続)。

### VERIFY

```sh
mise run check  # lint + typecheck + test:run + audit + lint:model-ids
# → lint: Checked 138 files, no fixes applied
# → typecheck: apps/web / apps/worker / packages/evals すべて Done
# → test:run: Test Files 54 passed (54), Tests 560 passed (560)
# → audit: No known vulnerabilities found
# → lint:model-ids: ✅ No hardcoded model IDs found
```

`.github/workflows/tests.yml` は `mise run check` の対象外(GitHub Actions 自体は CI 実行時
にのみ評価される)だが、YAML 構文の妥当性は PyYAML の `safe_load` 成功で確認済み。実際の
ジョブ分離・gate 集約の振る舞いは本 PR の CI 実行そのものが最終検証(Task 7.1 の観測対象)。

### 学び

- CI ワークフロー YAML の変更は「テスト対象コードが存在しない」タイプの Task 2 と異なり、
  構造(ジョブグラフ・`needs`・`if`)という検証可能な形式知を持つ。使い捨てスクリプトでの
  構造アサーションは、永続テストファイルを増やさずに RED→GREEN の規律を保てる妥当な代替と
  判断した。
- branch protection のような「リポジトリ設定の新規作成」は、対象チェックが CI 上で一度も
  観測されていない段階では実行を保留し、まず変更を PR で走らせてから作成する方が安全
  (ユーザー承認済みの判断)。次回同種タスクでも「チェックの初回実行 → 設定作成」の順序を
  デフォルトとする。
