# 005-baseline-recovery-refactor — PDCA Check

## Task 1.8: CI ワークフロー実走結果(初 push)

### コミット

- `50390f1547eade2da1b5da5a23fde5fe327db591` — `fix(deps): widen postcss/brace-expansion
  overrides, fix pytest rootdir import`(Task 1.1-1.7 の実装)
- push: `git push -u origin 005-baseline-recovery-refactor`(このブランチの初 push。
  push 前に `.githooks/pre-push` の E2E(18 passed / 4 skipped, Ollama)も green)

### 3 workflow の conclusion(run id 付き)

| workflow | run id | conclusion | html_url |
| --- | --- | --- | --- |
| `lint` | 30157580762 | ✅ success | https://github.com/Fukuchan77/vaz-ai-next/actions/runs/30157580762 |
| `tests` | 30157580758 | ✅ success | https://github.com/Fukuchan77/vaz-ai-next/actions/runs/30157580758 |
| `python` | 30157580767 | ✅ success | https://github.com/Fukuchan77/vaz-ai-next/actions/runs/30157580767 |

`tests` workflow の内訳ジョブ(`gate` が本 spec の目標対象):

| job | conclusion |
| --- | --- |
| `unit` | ✅ success |
| `audit` | ✅ success |
| `e2e` | ✅ success |
| `gate` | ✅ **success(初 green)** |

### `gate` 初 green の根拠(直前 2 回の失敗との対比)

本 spec 起票の契機となった advisory 未解消状態での直近 2 回の `tests` run は、いずれも
`audit`(→ `pnpm audit --audit-level=moderate` が 2 件の advisory で non-zero exit)経由で
`gate` が failure だった:

| run id | branch | audit | gate |
| --- | --- | --- | --- |
| 30150062182 | `claude/spec-004-pending-refactor-plan-jsxxbc` | ❌ failure | ❌ failure |
| 30148997568 | `004-debt-closeout-refactor` | ❌ failure | ❌ failure |
| **30157580758** | **`005-baseline-recovery-refactor`(本コミット)** | **✅ success** | **✅ success** |

→ Task 1.2 の override 是正(`postcss@<8.5.18`→`^8.5.18` / `brace-expansion` →`^5.0.8`)が
CI 環境(GitHub Actions ubuntu-latest, ローカル環境変数汚染なし)でも advisory 0 件を再現し、
`gate` が初めて green になったことを確認した(要件 1.4)。

### 異常事象の記録: push 後 ~2h45m の `queued` 停滞(root cause 未確定)

- push 直後(2026-07-25T12:12:21Z)に 3 workflow とも `queued` で作成されたが、
  `updated_at` が一切進まないまま **約 2 時間 45 分**停滞(実際にジョブが開始したのは
  `2026-07-25T14:58:54Z` 前後)。
- 調査した範囲(read-only, 追加スコープなしの `gh` トークンで確認可能な範囲)で切り分けた結果:
  - GitHub 全体の障害は無し(githubstatus.com: All Systems Operational)。
  - リポジトリ側の設定異常は無し(`actions/permissions.enabled: true`、全 workflow
    `state: active`、`runs-on: ubuntu-latest` の標準ラベルのみ、`environment:` ゲート無し、
    同一 concurrency group 内に stuck な cancelling run も無し)。
  - 同ブランチの直前の push(数時間前、他 spec)は queued→completed が 1 分前後で
    完了していたため、リポジトリ構成自体が恒常的に遅いわけではない。
  - account 単位の同時実行ジョブ枠(Free プラン既定 20)や Actions 支出上限は
    `user` スコープの billing API が必要で、本セッションの `gh` トークン(`repo`/`read:org`
    等)では確認不能だった。
- **結論**: root cause は未確定(GitHub 側の一時的なランナー割当遅延の可能性が最も高いが、
  確定情報なし)。最終的にジョブは介入なしで自然に開始・完走し、全 green で終わった。
  ユーザーへの是正提案(billing 設定確認)は保留(次回再発時に再検討)。**恒久対応は要さない
  ため spec の Out-of-Scope 台帳(Task 6)への新規登録は行わない** — CI 実行そのものの
  結果(green)には影響しなかったため。

### 結論

`gate` の初 green を確認した(要件 1.4 の実地検証完了)。lint / tests / python の 3 workflow
すべて success。Task 1(R1: CI ゲートの回復)は本コミットで実効的に完了。

## Task 2: DB baseline の起票(R2)

### 検証コマンドと結果

| コマンド | 結果 |
| --- | --- |
| `pnpm exec vitest run --project packages packages/db/tests` | **PASS** — 3 test files / 51 tests(`schema.spec.ts` 15 既存 + `schema-ddl.spec.ts` 22 新規 + `migrate.spec.ts` 14 新規) |
| `pnpm exec vitest run --project packages packages/db/tests/migrate.spec.ts` | **PASS** — 14 tests |
| `mise run check`(lint + typecheck + test:run + audit + lint:model-ids) | **PASS** — `pnpm exec vitest run` 610 passed(56 test files)/ biome 0 errors / `pnpm -r run typecheck` 全 package Done / `pnpm audit --audit-level=moderate` No known vulnerabilities / `lint:model-ids` No hardcoded model IDs |
| `docker info` | **到達不能** — `failed to connect to the docker API at unix:///var/run/docker.sock; ... dial unix /var/run/docker.sock: connect: no such file or directory`。CLI (`/Users/k-fukuda/.rd/bin/docker`, Rancher Desktop) は存在するが daemon 未起動。 |

### R2.6 honest-skip 記録

**AC 2.6**: 「WHEN docker 到達環境で実行された時, `docker compose up -d db` → `mise run
db:migrate` → `psql` による実在確認(`vector(768)` 列と 2 enum)SHALL be recorded in
pdca/check.md(到達不能な場合は honest-skip として理由付きで記録)」

- **実施日**: 2026-07-25
- **状態**: **honest-skip**
- **理由**: `docker info` が daemon 未起動エラーで失敗(上表)。本セッションの実行環境では
  Docker daemon(Rancher Desktop)が起動していないため `docker compose up -d db` から先の
  手順(`mise run db:migrate` の実 DB 適用、`psql` での `\d chunk` / `\dT+ job_status` 実在確認、
  再実行による冪等性確認)を実施できなかった。
- **代替で満たしている保証**: `packages/db/tests/schema-ddl.spec.ts`(DB 接続不要)が
  baseline + delta の SQL と `schema.ts` の整合を機械的に保証しており、R2.2 の機械保証要件は
  満たしている。`packages/db/tests/migrate.spec.ts` が `db:migrate` の純粋部分(ファイル列挙・
  未適用判定・fail-loud メッセージ)を保証している。未検証なのは「実 PostgreSQL に対する
  `CREATE EXTENSION`/`CREATE TYPE`/`CREATE TABLE` の実行可能性」と「`_vaz_migration` を用いた
  冪等再実行」の 2 点のみ。
- **申し送り**: docker 到達可能な環境(または本セッションで Rancher Desktop を起動した後)で
  次を実施し、本ファイルの本節を更新すること:
  ```
  docker compose up -d db
  mise run db:migrate
  psql "$DATABASE_URL" -c "\d chunk" -c "\dT+ job_status"
  mise run db:migrate   # 冪等性確認(2 回目は "no pending migrations" になるはず)
  ```
- **5.4 との関係**: R5.4(004 act.md 申し送り 1 = locator E2E 実スタック実走)も同じ docker
  未到達により本セッションでは実行可能状態への到達を確認できていない(Task 5 で再判定する)。
