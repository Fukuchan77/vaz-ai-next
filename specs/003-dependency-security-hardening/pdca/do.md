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

## Task 7: 002 の運用上の未実施確認

- **実施日**: 2026-07-24
- **Boundary**: `specs/003-dependency-security-hardening/pdca/`(記録のみ)
- **Requirements**: 5.1, 5.2, 5.3

### 方針

Task 1–6 とは性質が異なり、コード変更を含まない運用観測タスク。7.1(PR での
`eval-pr.yml` 遷移観測)には本 spec の PR が実在する必要があり、7.2(M3 locator
E2E)には起動中の Docker + Ollama + `services/agent` が必要。いずれもこのセッション
時点で未整備だったため、着手前にユーザーへ「push して PR を作成するか」「Docker を
起動して実行するか」「nightly 履歴をどう確認するか」の3点を確認し、全て
「実施する」の承認を得た(`AskUserQuestion`)。

### 7.1 — PR 作成と `eval-pr.yml` 観測

- `git push -u origin 003-dependency-security-hardening` → `gh pr create` で
  PR #4(<https://github.com/Fukuchan77/vaz-ai-next/pull/4>)を作成。
- CI 結果(`gh pr checks 4`): `unit`/`audit`/`e2e`/**`gate`** すべて `pass`。
  **Task 3 で新設した集約 `gate` ジョブが実際の PR 上で初めて実行され green を
  確認**(do.md Task 3 の「実際のジョブ分離・gate 集約の振る舞いは本 PR の CI
  実行そのものが最終検証」を消化)。branch protection 新規作成の運用者向け手順は
  PR 本文に転記済み(Task 3 の fallback どおり)。
- `eval-pr-gate`(`eval-pr.yml`)ジョブも `pass`(5秒)だったが、ログを確認すると
  **`Gate on provider API key` ステップで `ANTHROPIC_API_KEY is not configured —
  skipping PR eval gate.` と出力され、以降の全ステップ(`checkout` 以降)が
  `if: steps.gate.outputs.enabled == 'true'` の条件不成立でスキップされていた**
  (`gh run view 30091171227 --log` で確認)。つまり `packages/evals/src/
  pr-gate.ts` の閾値ブロック判定コード自体が一度も実行されていない。
  `eval-nightly.yml` も同一ゲート機構(`gh run view 30032119657 --log`、
  2026-07-23 分)で常に skip しており、これは本 spec 由来ではなく **リポジトリ
  Secrets に `ANTHROPIC_API_KEY` が設定されていない**という既存の環境制約。
- **結論(5.1)**: 「`eval-pr.yml` の閾値ブロック判定への遷移」自体は**観測できな
  かった**(observe できたのは「secret 未設定によりゲート実行前にスキップする」
  という既知の分岐)。gap-analysis の「golden set 20件到達で reportOnly=false」
  という**コード上の判定条件**は事実だが、それより前段の provider-key ゲートで
  ジョブ全体が止まるため、閾値判定コードへの到達自体がリポジトリ Secrets の追加
  という運用者アクション待ちである。**5.1 は「secret 未設定により本セッションでは
  観測不能」として完了扱いとし、`ANTHROPIC_API_KEY` を Secrets に追加した後の
  次回 PR で改めて観測することを申し送る**(002 Req 5.4 の初回観測はこの申し送り
  をもって pending 継続)。

### 7.2 — ローカル docker compose + Ollama での M3 locator E2E

**環境構築**(このリポジトリで実 DB への migration 適用が実証されたのは今回が
初めて — 001 Task 8.1 / 002 Task 7.6 の FLAG「サンドボックスから pgvector image
pull 不可のため一度も実証されていない」を本セッションで解消):

1. `docker compose up -d db` → `pgvector/pgvector:pg17` を pull・起動(healthy)。
2. `packages/rag/src/db/schema.ts` から手書きで導出した DDL(6 テーブル + 2 enum
   + `vector(768)` HNSW index + `embedding_dim_fixed` CHECK)を
   `docker exec vaz-postgres psql` で適用。drizzle-kit は依然未導入
   (002 Task 7.6 の既知の判断を継承)なので、恒久的な migration ファイルとしては
   コミットしない一時的なローカル検証専用の DDL(本 spec の Boundary は
   `pdca/` のみであり `packages/rag/drizzle/` への追加は対象外)。
3. `cd services/agent && uv run uvicorn app.main:app --port 8000`(`.venv` は
   Task 5 検証時に sync 済みで再利用、Docling/RapidOCR のモデル初回 DL のみ発生)。
4. `DATABASE_URL=postgres://vaz:vaz@localhost:5432/vaz AGENT_SERVICE_URL=
   http://localhost:8000 AI_PROVIDER=ollama pnpm exec playwright test
   apps/web/tests/e2e/locator-citation.spec.ts --project=chromium`
   (Ollama は `llama3.2`/`nomic-embed-text` 既存 pull 済みモデルを使用)。

**結果(1 回目)**: `services/agent` への `POST /parse` は `200 OK`(Docling
+ RapidOCR 経由でテキスト抽出・chunk 化に成功)。Ingest CLI(`--via-parser`)も
例外なく完了。しかしテスト自体は
`page.getByText("You")` の strict-mode violation で失敗
(`"...Cite your source."` の `"your"` が大文字小文字無視の部分一致で `"You"` に
ヒットし 2 要素に解決 — テスト側の既存バグ、本 spec の変更と無関係)。

**診断のための一時的な修正(コミットしない)**: `getByText("You", { exact: true
})` へ一時的に書き換えて再実行(診断専用、Task 7 の Boundary が `pdca/` のみのため
実行後に `git checkout --` で原状復帰済み)。2 回目の結果:

- `You`/`AI` のチャット往復自体は成功。`searchDocuments` ツールの実出力
  (`error-context.md` のページスナップショットで確認)は
  `"content":"The internal project codename for the Q3 filing overhaul is
  Nightjar-"` — **末尾の `19.` が欠落**していた。AI の応答文も「Nightjar」
  (`-19` 抜け)とパラフレーズしていた。
- テストの `toolOutput.filter({ hasText: CODENAME })`(`CODENAME =
  "Nightjar-19"`)がこの欠落により 0 要素にマッチし、150 秒タイムアウトで失敗。
- **原因は未確定(本タスクの Boundary 外につき深掘りせず記録のみ)**: 有力な仮説は
  (a) テストが実行時に手組みする「フォント埋め込みなしの最小 PDF」が Docling の
  ネイティブテキスト抽出に失敗し RapidOCR(ログで確認済み: `Using engine_name:
  torch` 他)へフォールバックし、OCR が末尾の "19." を誤認識/欠落させた、
  (b) `HybridChunker` が単一文をトークン境界で分割し `"19."` が別チャンクに
  分離され、ベクトル検索の top-1 に含まれなかった。いずれも本 spec(依存
  advisory 対応)の変更が原因ではなく、002 の既存テスト資産の環境依存の脆さ
  (合成 PDF フィクスチャ + 実 Docling/OCR 経路)に起因する新規発見。
- **結論(5.2)**: `mise run test:e2e:ollama` 相当を実 docker compose + Ollama で
  1 回実行し、結果を記録した(要求どおり)。**M3 locator E2E は現状 fail**(上記
  2 つの独立した原因: (1) 既存テストの `getByText` 曖昧一致バグ、(2) 合成 PDF の
  実 Docling/OCR 経路での末尾文字欠落)。両方とも 002 由来の既存資産の問題であり
  本 spec のスコープ外(Boundary は記録のみ)のため、コード修正は行わず
  002 側の追跡課題として申し送る。002 `pdca/act-final.md` の PENDING は
  「未実施」から「実施済み・fail・原因の当たりまで記録」へ更新される。

**後片付け**: `services/agent` の uvicorn プロセスを終了、`docker compose down`
でコンテナ/ネットワークを削除(手書き DDL は非コミットの一時状態であり、
次回同様の検証時は再適用が必要— この手順自体を `docs/dependency-policy.md` 等の
恒久文書に転記することは本タスクの Boundary 外)。

### 7.3 — 依存バンプ後 nightly の tier1/tier3 verdict 比較(任意)

- `gh workflow list` → `eval-nightly`(nightly)。直近 10 回(2026-07-14〜
  2026-07-23)すべて `success` だが実行時間は 6〜10 秒のみ。
  `gh run view <run-id> --log` で確認したところ、`eval-nightly.yml` も
  7.1 で見た `eval-pr.yml` と同一の `ANTHROPIC_API_KEY` gate を持ち、
  **secret 未設定のため実際の tier1/tier3 評価ステップは一度も実行されず
  即 skip している**(依存バンプ以前・以後を問わず、観測期間内すべて同一)。
- 2026-07-24(依存バンプ実施日)の nightly はまだ発火していない
  (直近ログは 2026-07-23T18:04 UTC、確認時刻は 2026-07-24T12:03 UTC。
  スケジュールは概ね 17:44–18:05 UTC 帯であり本日分は未発火)。
- **結論(5.3)**: 依存バンプ前後で比較可能な tier1/tier3 verdict データは
  **存在しない**(nightly が secret 未設定により恒常的に skip しているため)。
  Requirement 5.3 は「IF 変化があれば記録する」条件文であり、変化を観測する
  前提となる実行自体が発生していないため、**「変化なし(データ不在により
  比較不能)」として完了**とする。`ANTHROPIC_API_KEY` を Secrets に追加した後の
  nightly 実行から再評価が必要(7.1 の申し送りと同根)。

### VERIFY

7.1/7.2/7.3 はいずれも観測・記録タスクであり、コード変更を伴わない
(7.2 の診断用一時修正は実行後に `git checkout --` で復元済み、`git status`
で無変更を確認)。既存の集約ゲートへの影響なし。

```sh
git status --short apps/web/tests/e2e/locator-citation.spec.ts
# (出力なし = 変更なし)
```

### 学び

- **`ANTHROPIC_API_KEY` 未設定という1つの環境制約が 5.1 と 5.3 の両方を同時に
  ブロックしていた**: 002 の運用確認3件のうち2件(5.1/5.3)は、実装ロジックの
  問題ではなく同一のリポジトリ Secrets 未設定に起因する。次回この secret を
  追加すれば両方が同時に解消する可能性が高く、個別に追跡するより「secret 追加」
  という単一のフォローアップとして 002 側に記録する方が適切。
- **サンドボックス制約は環境が変われば解消する**: 001/002 で「pgvector image
  pull 不可のため実証不能」と繰り返し記録されていた FLAG は、本セッションの
  Docker 環境では単純に image pull が可能だった。過去の FLAG を鵜呑みにせず、
  現在の環境で再確認する価値があった(実際に実 DB migration が初めて実証できた)。
- **診断用の一時的なコード変更は Boundary を超えない範囲でも価値がある**:
  `getByText("You")` の曖昧一致を一時的に厳密化したことで、テスト失敗の真因が
  1つ(既知バグ)ではなく2つ(既知バグ + 新規発見の PDF/OCR 欠落)重なっていた
  ことが分かった。恒久修正はしない(Boundary 外)が、原状復帰前に診断だけ
  済ませることで記録の精度が上がった。
- **CI 実行そのものが最終検証になるタスク(Task 3)は、実際に PR を通すまで
  「本当に動く」と言い切れない**: `gate` ジョブの YAML 構造検証(Task 3 VERIFY)
  は妥当だったが、実際に GitHub Actions 上で `unit`/`audit`/`e2e`/`gate` が
  揃って green になったのは本 PR が最初(このタスクの副産物として Task 3 の
  最終検証が完了した)。

## Task 8 — 追加の防御的ハードニング(self-review 発見)

### DO

本 spec の作業中、既存タスクの Boundary 内で self-review した結果、3 件の
防御的ハードニングを追加で発見・実装した(いずれも直前まで tasks.md に
存在せず、`/sdd-ship` 起票時に spec.md Requirement 6 / tasks.md Task 8 として
追記して追認した)。

- **8.1 `prompt.ts`**: `formatChunk` が未信頼の chunk `source`/`content` を
  そのまま `RETRIEVED_CONTEXT_BEGIN`/`END` の間に埋め込んでいたため、
  chunk 内容にこれらのリテラル文字列が偶然/意図的に含まれると、区切りブロックを
  早期に閉じたように見せかけられる余地があった。`escapeDelimiters` で両方の
  未信頼フィールドを無害化した。sticky taint(`externallyDriven`)の latch 条件は
  「chunk が注入されたか」であり区切り文字の完全性に依存しないため、この修正は
  権威側の表示崩れを防ぐ防御であって、latch 条件自体の変更ではない。
- **8.2 `pr-gate.ts`**: `readBaselineSample` は元々 `try { JSON.parse(...) } catch { return
  undefined }` の一枚岩で、「baseline ファイルが存在しない」(正常・無警告)と
  「存在するが読めない/壊れている/形状が違う」(異常・要警告)を区別していなかった。
  後者が発生すると regression blocking が無警告で無効化される。ENOENT・読み取り
  エラー・JSON parse エラー・`PrGateRunSample` 形状不一致の 4 経路に分離し、
  後三者は `console.warn` を出すよう変更。`isPrGateRunSample` 構造ガードを追加し、
  関数を export してユニットテスト可能にした。
- **8.3 `llama.py`**: `resolve_judge_llm` 内に Task 5.1 で `routes/eval.py` から
  除去したのと同じパターンの bare `assert judge_model is not None` が残っていた
  (Task 5.1 の Boundary は `routes/eval.py` のみだったため対象外だった)。同一の
  理由(`python -O` 下で検査が消える)で `RuntimeError` へ置換。`Settings` が
  既定値を保証するため実務上到達不能だが、Task 5.1 と一貫させた。

### VERIFY

- `pnpm exec vitest run --project packages packages/agents/tests/prompt.spec.ts
  packages/evals/tests/pr-gate.spec.ts` → 2 files / 48 tests green
  (forged BEGIN/END/source delimiter 3 ケース、`readBaselineSample` の
  正常系+異常系 5 ケースを新規追加)。
- `mise run py:check`(uv sync + ruff + pyright + pytest)→ 61 tests green。
- `mise run check`(lint + typecheck + audit + test:run)→ 572 tests green
  (Task 1 時点の 559 から本タスクの新規テスト分増加)。
- `mise run build`(`NODE_ENV=production`)→ 6 routes 生成、成功。

### 学び

- **タスク境界の厳密な遵守が、隣接する同種の欠陥を見落とす原因になり得る**:
  Task 5.1 は `routes/eval.py` に Boundary を絞ったことで正しく完了したが、
  同一ファイル内の別関数(`resolve_judge_llm`)にある同種の bare `assert` は
  対象外のまま残った。Boundary は変更の副作用を防ぐには有効だが、「同じ理由で
  他にも存在するはずのパターン」を横断的に grep する self-review のステップを
  別途挟む価値がある。
- **`/sdd-ship` 起票時に未計画の差分が見つかった場合、後追いで spec/tasks に
  追記してから検証・コミットする方が、`tasks.md` 更新なしでコミットするより
  トレーサビリティを保てる**: 3 件とも既存 Requirement の実装意図を強化する
  ものであり、新規 Requirement(R6)として明文化したことで、次回の Check が
  「未計画のコミット」として誤検出しない。

## Task 8 補遺 — `/sdd-reflect` 後の adversarial-review 発見分の追加修正

- **実施日**: 2026-07-24
- **Boundary**: `packages/evals/src/pr-gate.ts`, `packages/evals/tests/pr-gate.spec.ts`
- **Requirements**: 6.2(の強化)

### 経緯

`/sdd-reflect` で `pdca/check.md`/`act.md` を生成した後、adversarial-review スキルで
本 spec の実装コードを再点検した。`isPrGateRunSample`(8.2 で追加した構造ガード)が
`results` を `Array.isArray` でのみ検証し、**要素の形状を検証していない**ため、
`{"results":["garbage"],"totalDurationMs":1}` のような valid-JSON-but-wrong-shape な
baseline が素通りし、`computePassRate`/`computeTriggerBalance` に非オブジェクトが渡って
`NaN` 系の誤ったメトリクスを静かに生成し得る(クラッシュではなく誤値なので気づきにくい)
という LOW 指摘を受けた。8.2 の意図(「baseline が壊れている場合を silent に regression
blocking 無効化させない」)が要素レベルでは未完だったための追加修正。

同時に、reflection 文書(`pdca/check.md`/`act.md`)の要件カバレッジ集計が「17/20」と
誤記(本 spec の AC 総数は 21 — R1:5+R2:4+R3:3+R4:3+R5:3+R6:3)されていた MEDIUM 指摘も
あり、両文書を「17/21 covered, 4/21 partial」に修正済み(ドキュメントのみの修正のため
本 Boundary には含まない)。

### 実施内容

`isPrGateRunSample` を 2 段構成に変更: (1) コンテナ形状(`totalDurationMs` が number、
`results` が array)を先に確認、(2) `results` の各要素が非 null オブジェクトかつ
`NightlyCaseResult` の判別子(`skipped: boolean`)を持つことを `Array.prototype.every`
で検証。空配列(`results: []`)は既存テスト(`baseline.json` の正常系)が正当と定義済みの
ため、要素チェックの対象がないだけで従来通り valid のまま維持(空配列を invalid とする
過剰な変更は行わない)。

### GREEN

`pr-gate.spec.ts` の `test.each` に 2 ケース追加(`results` 要素が非オブジェクト /
`skipped` 判別子欠落)、既存の「正常系(空配列含む)は valid」ケースは無改変。

```sh
pnpm exec vitest run --project packages packages/evals/tests/pr-gate.spec.ts
# → 1 file / 33 tests passed(8.2 時点の 31 から本補遺の 2 ケース増)
```

### VERIFY

```sh
mise run check   # lint + typecheck + test:run + audit + lint:model-ids
# → test:run: Test Files 54 passed (54) / Tests 574 passed (574)
# → 他 4 ステージ green

mise run py:check   # uv sync + ruff + pyright + pytest
# → 61 passed、pyright 0 errors

unset NODE_ENV && mise run build
# → NODE_ENV=production 強制、6 routes 生成、成功
```

全ゲート green。

### 学び

- **`Array.isArray` だけの構造ガードは「コンテナが配列であること」しか保証しない**。
  要素の形状まで手動で書いた `isPrGateRunSample` のような構造ガードは、コンテナと
  要素の両方を検証しないと「valid っぽいが中身が違う」データを静かに通してしまう
  (8.2 の当初実装がこの半分だけを実装していた)。
- **`/sdd-reflect` 後でも adversarial-review で実装 LOW/MEDIUM が見つかることがある**。
  Check/Act は「実装が計画どおりか」を確認するが、実装自体の残存欠陥の発見は別の
  レンズ(敵対的レビュー)が必要。発見した修正は当該タスクの補遺として `do.md` に
  遡及記録し、`tasks.md` の該当 AC(6.2)は「強化」として扱う(新規タスク番号は
  振らない — 既存 AC の実装範囲内の修正のため)。
