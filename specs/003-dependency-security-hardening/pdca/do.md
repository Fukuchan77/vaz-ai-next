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

## Task 4: `NODE_ENV` build quirk の恒久対処

- **実施日**: 2026-07-24
- **Boundary**: `mise.toml`, `.github/workflows/tests.yml`, `apps/web/src/app/global-error.tsx`
- **Requirements**: 3.1, 3.2, 3.3

### 実施内容

- 4.1: `mise.toml` `[tasks.build]` の `run` を
  `NODE_ENV=production pnpm --filter @vaz/web exec next build` に変更(`test:e2e:ollama` の
  `AI_PROVIDER=ollama` 前置と同じインライン env パターン)。理由をコメントで明記。
- 4.2: `.github/workflows/tests.yml` の `e2e` ジョブ `Build` ステップに
  `env: { NODE_ENV: production }` を追加。
- 4.3: `apps/web/src/app/global-error.tsx` の NOTE を、quirk の説明はそのまま維持しつつ
  「この quirk はここでは直さず、ビルド経路側(`mise run build` / CI `e2e` Build ステップ)が
  `NODE_ENV=production` を明示的に強制する」旨へ更新(回避策の知識をコメント内に閉じ込めず、
  実際に強制している場所を指す)。

### TDD の適用(RED→GREEN、ビルド quirk の再現/解消として実施)

`next build` の prerender 失敗はユニットテスト化できない(ビルドプロセス自体の振る舞い)ため、
実ビルド実行を RED/GREEN の検証手段とした。CI YAML の構造は Task 3 と同様 PyYAML による
使い捨て構造検証を用いた。

**RED**(変更前、`NODE_ENV=development` シェルから `mise run build` を実行):

```
$ NODE_ENV=development mise run build
...
Error occurred prerendering page "/_global-error". Read more: https://nextjs.org/docs/messages/prerender-error
TypeError: Cannot read properties of null (reading 'useContext')
...
Export encountered an error on /_global-error/page: /_global-error, exiting the build.
[build] ERROR task failed
```

期待通り、既存コードで quirk が再現することを確認した。

**GREEN**(変更後、`NODE_ENV` 未設定シェルおよび `NODE_ENV=development` シェルの両方で確認):

```
$ unset NODE_ENV && mise run build
[build] $ NODE_ENV=production pnpm --filter @vaz/web exec next build
✓ Compiled successfully in 8.4s
✓ Generating static pages using 7 workers (6/6) in 150ms
Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /api/chat
├ ƒ /api/jobs
├ ƒ /api/jobs/[id]/approve
└ ƒ /api/jobs/[id]/stream

$ export NODE_ENV=development && mise run build
[build] $ NODE_ENV=production pnpm --filter @vaz/web exec next build
✓ Compiled successfully in 7.9s
✓ Generating static pages using 7 workers (6/6) in 150ms
（ルート構成は上記と同一)
```

両シェル環境で全ルートが prerender 成功。件数はビルド出力で確認したもので、検証記述には
固定件数を埋め込まない(4.4 の要求どおり)。

`tests.yml` の e2e Build ステップは PyYAML で構造検証:

```
PASS: e2e Build step env.NODE_ENV == production
{'name': 'Build', 'run': 'pnpm --filter @vaz/web run build', 'env': {'NODE_ENV': 'production'}}
```

### VERIFY

```sh
mise run check  # lint + typecheck + test:run + audit + lint:model-ids
# → lint: Checked 138 files in 156ms, no fixes applied
# → typecheck: apps/web / apps/worker / packages/evals すべて Done
# → test:run: Test Files 54 passed (54), Tests 560 passed (560)
# → audit: No known vulnerabilities found
# → lint:model-ids: ✅ No hardcoded model IDs found
```

全ゲート green。加えて `mise run build` を `NODE_ENV` 未設定・`development` の両条件で
実行し、いずれも green(上記 RED/GREEN セクション参照)。

### 学び

- ビルドプロセスの quirk(フレームワーク内部の prerender 失敗)はコードを直さずビルド経路を
  固定することで解消するケースがある。この場合、RED/GREEN は「実際にビルドを実行して結果を
  比較する」ことが最も直接的な検証手段であり、無理にユニットテストへ落とし込む必要はない。
- コメント(`global-error.tsx` の NOTE)に回避策の知識を書く場合、回避策そのものだけでなく
  「実際にどこで強制されているか」への参照を含めることで、将来 `mise.toml`/`tests.yml` 側が
  変更された際にコメントが孤立した誤情報にならないようにできる。

## Task 5: Python サイドカーの小粒ハードニング

- **実施日**: 2026-07-24
- **Boundary**: `services/agent/app/routes/eval.py`, `services/agent/app/eval/llama.py`,
  `services/agent/tests/`
- **Requirements**: 4.1, 4.2, NFR-3

### 実施内容

- 5.1: `routes/eval.py` の `faithfulness`/`relevancy` 両ハンドラの
  `assert judge.last_usage is not None, "..."` を `usage = judge.last_usage; if usage is None:
  raise RuntimeError(...)` へ置換(ローカル変数化で pyright strict の narrowing を維持)。
- 5.2: `llama.py` `to_token_usage` を `usage.total_tokens`(provider-reported)採用へ変更
  (旧実装は `usage.input_tokens + usage.output_tokens` を自前で再計算していた)。
- 5.3: `mise run py:check` green を確認(下記 VERIFY)。

### RED(5.1: `services/agent/tests/test_eval.py::TestMissingUsageInvariant`)

`PydanticAIJudgeLLM` を継承し `achat` で `last_usage` を書き込まない
`_JudgeWithoutUsageTracking` を追加し、`/eval/faithfulness` / `/eval/relevancy` の両方に対して
`pytest.raises(RuntimeError, match="achat records usage")` を要求するテストをコード変更前に追加。
変更前の実行で期待どおり `AssertionError` を確認(RED):

```
tests/test_eval.py:67: assert judge.last_usage is not None, "achat records usage on every aevaluate() call"
E   AssertionError: achat records usage on every aevaluate() call
2 failed, 8 deselected in 0.47s
```

### RED(5.2: `services/agent/tests/test_llama.py`)

- 既存 `test_to_token_usage_sums_input_and_output` は「provider の `total_tokens` を透過する」
  意図に命名・docstring を更新(`test_to_token_usage_passes_through_the_runs_reported_values`)。
- 新規 `test_to_token_usage_does_not_recompute_the_total_from_input_and_output` を追加し、
  変更前の実行で期待どおり失敗を確認(RED):

```
assert result.total_tokens == 1_008
E   assert 8 == 1008
E    +  where 8 = TokenUsage(input_tokens=5, output_tokens=3, total_tokens=8).total_tokens
1 failed, 1 passed, 18 deselected in 0.08s
```

### GREEN

`routes/eval.py`(5.1)・`llama.py`(5.2)を変更後:

```sh
uv run pytest tests/test_eval.py tests/test_llama.py -q
# .............................. 30 passed in 0.24s
```

### VERIFY

```sh
mise run py:check
# [py:check] $ uv sync            → Resolved 198 packages
# [py:check] $ uv run ruff check . → All checks passed!
# [py:check] $ uv run pyright      → 0 errors, 0 warnings, 0 informations
# [py:check] $ uv run pytest       → 61 passed in 0.28s
```

全ゲート green。

### 学び・計画との齟齬(重要)

- **tasks.md 5.2 の前提を実装調査で反証した**: 計画は「`RunUsage.total_tokens` は
  cache/reasoning トークンを含みうるため `input_tokens + output_tokens` と一致しない場合がある」
  ことを前提に、`cache_read_tokens`/`cache_write_tokens` を非 0 にした `RunUsage` で
  `total_tokens != input_tokens + output_tokens` となるケースをテストせよ、としていた。
  しかし pin されている `pydantic-ai` 2.13.0 の実装(`RunUsage`/`UsageBase`)を直接確認した結果、
  `total_tokens` プロパティは常に `input_tokens + output_tokens` を返す定義であり、かつ
  `input_tokens` 自体が `cache_read_tokens`/`cache_write_tokens` を**既に含む**契約
  (docstring: "this total includes cached tokens")になっている。つまりこのライブラリ版では
  実在する `RunUsage` で両者を分岐させることは原理的に不可能(反例を構築できない)。
- **対応**: 「実際の `RunUsage` では起きない」という事実を踏まえつつ、5.2 が検証したい本質
  ―― `to_token_usage` が provider の `total_tokens` を**再計算せず透過する**契約 ―― を、
  `RunUsage` を継承して `total_tokens` プロパティのみをオーバーライドするテストダブル
  (`_DivergingTotalUsage`)で直接検証する形に置き換えた。これは「将来 `pydantic-ai` が
  `total_tokens` の定義を変えた場合(例: reasoning トークンを別枠で加算するようになった場合)に
  このコードが追随する」という契約そのものをテストしており、実装の意図(「再計算しない」)を
  ライブラリの現行仕様の真偽に依存せず検証できる。
- **一般化できる学び**: plan.md/tasks.md がサードパーティ ライブラリの型の存在だけでなく
  「振る舞いの前提」まで踏み込んで指示している場合、実装前にその前提をソース直読で検証する
  ことが必要(gap-analysis は `total_tokens` の**存在**は確認していたが、**セマンティクス**
  までは確認していなかった)。前提が反証された場合はテストの盲目的な作成を避け、検証したい
  契約の本質に立ち返ってテスト手法を選び直す。

## Task 6: 002 spec への Req 2.7b 所管の明文化

### 方針

ドキュメントのみの追記タスク(コード変更なし)。TDD の RED-GREEN サイクルは適用対象外
――対象は `specs/002-pydantic-enhance/spec.md` の Requirement 2 セクションへの注記追加のみ。
plan.md の指示(「002 の実装・判定履歴は書き換えない、追記のみ」)を厳守し、既存の
Acceptance Criteria(2.1〜2.7 の文言・判定マーカー)は一切変更していない。

### GREEN(実装)

`spec.md` の Req 2.7(L145)の直後に、`> ` ブロッククオートで以下を追記(1 段落):

> Req 2.7b(`/eval/*` リクエスト経路での `traced_span` 実配線)は Phase B の必須 SHALL の
> 範囲外であり、Phase E 所管とする。相関 ID(`case_id`/`job_id`)は `services/agent` 単体では
> 保持せず、呼び出し側 = nightly runner が持つため、配線は Phase E(評価の還流)側のタスクと
> して実施する(詳細な検出経緯は `pdca/act-phaseB.md` を参照)。

既存の判定履行(`check-phaseB.md` 等の Gap 記録、`act-phaseB.md` の Mistake Record)は無改変。

### VERIFY

コード非変更のため、退行が無いことをプロジェクト全体の集約ゲートで確認:

```sh
mise run check
# [lint] Checked 138 files in 136ms. No fixes applied.
# [lint:model-ids] ✅ No hardcoded model IDs found
# [typecheck] apps/web / apps/worker / packages/evals ... 全 Done
# [test:run] Test Files  54 passed (54) / Tests  560 passed (560)
# [audit] No known vulnerabilities found
```

全ゲート green(既存 560 テストに regression なし)。tasks.md 6.1 を `[x]` に更新。
