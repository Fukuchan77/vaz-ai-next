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
