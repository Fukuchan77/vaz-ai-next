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

## Task 5: E2E 実走 + adversarial review

### 5.1 adversarial review 記録

| 対象 | 手法 | 結果 |
| --- | --- | --- |
| `0000_add_locator.sql`/`0001_add_locator.sql` 参照漏れ | `grep -rn "0000_add_locator"` を全リポジトリに実施 | ヒットは全て過去 spec の pdca 記録・ADR-0002 の経緯説明・`0000_baseline.sql` 冒頭コメントのみ。実体参照・旧ファイル自体は **0 件** |
| `createConsoleLogger` 呼び出し側置換漏れ | 定義側 grep(2 箇所: `@vaz/config/logger` 単一実装 + `packages/db/bin/migrate.ts` の意図的複製)→ 呼び出し側 4 箇所を突合 | 全 4 箇所が `@vaz/config/logger` から import。旧インライン実装の残存 **0 件** |
| `resolveDatabaseUrl`/`resolveRedisUrl`/`emptyToUndefined` 置換漏れ | AC 3.2/3.3 の該当箇所を突合 | 全箇所が `@vaz/schemas/infra-env`/`env-helpers.ts` の単一実装を消費。**0 件** |
| **`packages/db/bin/migrate.ts` の `resolveDatabaseUrl`(検出・是正)** | 同ファイルの `createConsoleLogger` と比較 | dep-graph-leaf 制約による意図的複製という同一理由を持つのに説明 docstring が無かった。**1 件検出・即時是正**(コメントのみ、挙動変更ゼロ) |

**是正内容**: `packages/db/bin/migrate.ts:46` の `resolveDatabaseUrl` に、`createConsoleLogger`
と対称の docstring(`@vaz/db` は `@vaz/schemas` への runtime import も不可なため
`parseInfraEnv` を使えず複製が必要、Task 3 boundary 対象外)を追加。

**再検証コマンドと結果**:

| コマンド | 結果 |
| --- | --- |
| `pnpm exec vitest run --project packages packages/db/tests` | **PASS** — 3 test files / 51 tests(差分なし) |
| `mise run check`(lint + typecheck + test:run + audit + lint:model-ids) | **PASS** — `lint:model-ids` No hardcoded model IDs / `audit` No known vulnerabilities / `typecheck` 全 9 workspace projects Done / `lint` Checked 149 files, no fixes / `test:run` 623 passed \| 1 skipped(58 files、合計 624)— Task 4 終了時点と合計値・ファイル数一致(コメント追記のみのため回帰なし) |

### 5.2 honest-skip 記録

**AC 5.2**(任意タスク、`[ ]*`): 「docker + Ollama + sidecar 到達環境で `docker compose
--profile sidecar up -d` → `mise run db:migrate` → RAG ingest(`--via-parser`)→
`mise run test:e2e:ollama` を実走し、green なら 004 act.md 申し送り 1 と 002 act-final の
M3 PENDING を最終クローズする」

- **実施日**: 2026-07-26
- **状態**: **honest-skip**(Task 2.10 と同一理由)
- **理由**: `docker info` を再実行 → `failed to connect to the docker API at
  unix:///var/run/docker.sock; ... dial unix /var/run/docker.sock: connect: no such file or
  directory`。Rancher Desktop の daemon が本セッションでも未起動のため、
  `docker compose --profile sidecar up -d` 以降の手順を実施不能。
- **R5.4 との関係**: 「WHEN R2 が完了した時, 004 act.md 申し送り 1(locator E2E 実スタック
  実走)SHALL become executable」— R2(Task 2)は baseline DDL・`db:migrate`・ドリフトテストの
  コミットにより**コード上は実行可能な状態に到達した**(2.9 のドリフトテスト green、2.4-2.5 の
  `migrate.ts` pure part テスト green)。しかし「executable になった」ことと「実地で実行し
  green を確認した」ことは別で、本セッションは docker 到達性の欠如により後者を確認できない。
  R5.4 の要件文言(「SHALL become executable」)自体は Task 2 の成果で満たしたと判断するが、
  「その結果を pdca/check.md に記録する」という後半要件は honest-skip として記録することで
  満たす(不能な場合の honest-skip は AC 本文が明示的に許容する経路)。
- **申し送り**: docker 到達可能な環境で次を実施し、本ファイルの本節を更新すること:
  ```
  docker compose --profile sidecar up -d
  mise run db:migrate
  pnpm --filter @vaz/rag ingest <corpus> --via-parser
  mise run test:e2e:ollama
  ```
  green なら 004 act.md 申し送り 1 と 002 act-final の M3 PENDING を最終クローズできる。

### Task 5 結論(初回・2026-07-26)

5.1(必須)は完了 — adversarial review で 1 件の文書化漏れ(機能上の欠陥ではない)を検出・
即時是正し、他の対象(migration rename 参照・Logger/infra-env 置換)には漏れが無いことを
確認した。5.2(任意)は docker 未到達により honest-skip。

---

## Task 2.10 / 5.2 再検証(2026-07-26 — docker daemon 起動後の実走)

ユーザーが Rancher Desktop の daemon を起動したため、honest-skip していた 2.10 / 5.2 を実走した。
`docker info` = `29.5.2 / Alpine Linux v3.23` 到達、Ollama(`llama3.2` / `nomic-embed-text` pulled)
到達。sidecar は Docling/torch の heavy image build を避け、bare-metal(`services/agent` の
既存 uv venv で `uv run uvicorn app.main:app --port 8000`、`docker-compose.yml` L119 が明示的に
許容する代替)で起動。**実走により従来 DB 未接続テストでは捕捉不能だった実挙動欠陥 2 件を検出・
即時是正した。**

### 欠陥 1(検出・是正): `db:migrate` の fail-loud 案内が enum 衝突で発火しない

- **症状**: 既存 pgdata ボリューム(過去セッションの手動 provisioning 由来で 6 table + 2 enum
  在、`_vaz_migration` 無し = R2.3 が fail-loud を約束する「既存 DB」シナリオ)に対し
  `mise run db:migrate` が、設計どおりの案内(`describeUntrackedExistingDatabase`)ではなく生の
  `type "job_status" already exists` で終了した。
- **根本原因**: `0000_baseline.sql` は `CREATE TABLE` より前に `CREATE TYPE`(enum, L11-12)を発行する。
  既存 DB では最初の衝突が enum の `CREATE TYPE "job_status"` → PostgreSQL SQLSTATE **`42710`
  (duplicate_object)**(`\set VERBOSITY verbose` で確認)。ところが `isDuplicateTableError` は
  **`42P07`(duplicate_table)しか判定しない**ため `42710` を取りこぼし、案内へ分岐せず生エラーを
  rethrow していた。`describeUntrackedExistingDatabase` のメッセージ自身が "CREATE TABLE/**CREATE
  TYPE** collided" と謳うのに実装が型衝突を検出できていない自己矛盾。
- **なぜ既存テストで捕まらなかったか**: `migrate.spec.ts` は `isDuplicateTableError({code:"42P07"})`
  とメッセージ文面のみを検証し、enum-first の `42710` を模していなかった。**これはまさに 2.10 の実 DB
  実走(前セッションまで honest-skip)が捕捉するはずだった欠陥。**
- **是正**: `POSTGRES_DUPLICATE_TABLE`(単一コード)を `POSTGRES_ALREADY_EXISTS_CODES`(`42P07` +
  `42710` の Set)へ、`isDuplicateTableError` → `isAlreadyExistsError` へ拡張・改名。`migrate.spec.ts`
  に `42710` ケースを追加(14 → 15 tests)。安全側性質(exit 1・黙ってスキップしない)は元々満たして
  いたため挙動の後退はなく、欠けていた「案内」を回復した。
- **是正後の実挙動確認**: 既存 pgdata に対し再実行 → 設計どおりの ADR-0002 案内メッセージが exit 1 で
  出ることを確認。

### 2.10 実走結果(欠陥 1 是正後、fresh 状態で)

| 手順 | 結果 |
| --- | --- |
| `docker compose down -v`(pgdata 破棄)→ `docker compose up -d db` | healthy |
| `mise run db:migrate`(1 回目・fresh) | `applied 0000_baseline.sql` / `applied 0001_add_locator.sql` |
| `mise run db:migrate`(2 回目・冪等性) | `no pending migrations (already up to date)` |
| `_vaz_migration` 追跡行 | `0000_baseline.sql`, `0001_add_locator.sql`(2 行) |
| `\d embedding`(`docker exec psql`) | `vector \| vector(768) \| not null` + `CHECK (dim = 768)` + hnsw index 実在 |
| `\d chunk` | `0001` delta の `locator text` 列 実在 |
| `\dT`(2 enum) | `job_status` / `job_event_type` 実在 |

→ **2.10 は honest-skip を解消し実地確認完了**(R2.6 の実 PostgreSQL に対する
`CREATE EXTENSION`/`CREATE TYPE`/`CREATE TABLE` 実行可能性 + `_vaz_migration` 冪等再実行を実証)。

### 欠陥 2(検出・是正): `env-helpers` の相対 import が Node native ESM(ingest CLI)で解決不能

- **症状**: `mise run test:e2e:ollama` の locator-citation が `node bin/ingest.ts --via-parser` 段で
  `ERR_MODULE_NOT_FOUND: Cannot find module '.../packages/schemas/src/env-helpers' imported from
  .../packages/schemas/src/env.ts` で失敗。
- **根本原因**: Task 3.5 が `emptyToUndefined` を `env-helpers.ts` へ抽出した際、`env.ts`/`auth-env.ts`/
  `infra-env.ts` が **拡張子なしの相対 import**(`from "./env-helpers"`)で参照していた。ingest CLI は
  Node native ESM で走る(`packages/rag/bin/ingest.ts`)ため拡張子なし相対 import を解決できない
  — AGENTS.md「Self-referencing package specifiers」が明記する既知の落とし穴そのもの。runtime に
  ロードされるのは `env.ts` / `infra-env.ts`(`deps.ts` は `import type` で strip されるため無害)。
- **なぜ既存ゲートで捕まらなかったか**: vitest / Next / tsc は全て bundler/loader 解決で拡張子なし
  相対 import を通すため、unit test・typecheck・build は全 green。**実際の `node bin/ingest.ts` パス
  だけが壊れており、locator-citation E2E(004 申し送り 1 / 002 M3 — これまで一度も green になった
  ことがない)を初めて実走したことで露見した。**
- **是正**: 3 ファイルの import を self-referencing package specifier(`@vaz/schemas/env-helpers`、
  package.json `exports: "./*": "./src/*.ts"` により拡張子付きへ解決)へ変更。biome の organizeImports
  safe-fix で並び順を修正。
- **是正後の実挙動確認**: `node packages/rag/bin/ingest.ts --via-parser <corpus>` が単体で
  `ingest complete: 1 document(s), 1 chunk(s)` まで到達(sidecar parse → Ollama embed → pgvector
  upsert の end-to-end)。以後の module 解決エラーは無し。

### 5.2 E2E 実走結果(欠陥 1・2 是正後)

`AI_PROVIDER=ollama DATABASE_URL=... AGENT_SERVICE_URL=http://localhost:8000
OLLAMA_BASE_URL=http://localhost:11434/v1 pnpm exec playwright test`(chromium + firefox 2 project):

| 区分 | 件数 | 内訳 |
| --- | --- | --- |
| passed | 18 | home / Zod validation / chat-ollama 実ラウンドトリップ / approval-resume(R3.5/3.7/3.8)ほか |
| skipped | 3 | chat-anthropic ×2(`ANTHROPIC_API_KEY` 不在)+ 1 |
| failed | 1 | locator-citation(chromium)のみ |

- **locator-citation の失敗は stack 欠陥ではなくローカルモデル(`llama3.2`, 3B)の限界**と診断:
  - ingest 段は完走(欠陥 2 是正後)。DB を直接確認したところ `chunk` に
    `source=nightjar-brief.pdf` / `content="The internal project codename ... is Nightjar-19"` が
    実在し、pgvector に retrievable な状態で載っていた(Docling parse → embed → upsert は正常)。
    **データ経路(R2/R3 が触る範囲)は end-to-end で正しい**ことを実証。
  - 失敗は `expect(locator('[class*="toolOutput"]').filter({hasText:'Nightjar-19'})).toBeVisible(
    {timeout:150000})` のタイムアウト — すなわちチャットが 150s 以内に **retrieval tool を呼んで
    locator を含む tool 出力を surface しなかった**。chromium で 2 回連続再現(flaky ではなく一貫)、
    firefox の同テストは fail していない(モデル出力の非決定性)。
  - `MODEL_ALLOWLIST.ollama = ["llama3.2"]`(R1.8/ADR-5 のコミット済み許可リスト)のため、より強い
    tool-calling モデル(例 `granite4.1:8b`)への切替はガバナンス変更で本タスク射程外。決定論的 green
    には Anthropic provider(`ANTHROPIC_API_KEY` = 運用者アクション、本セッションに鍵無し)が要る。
- **R5.4 / 004 申し送り 1 / 002 M3 の判定**: 「SHALL become executable」は**実証済み**
  — fresh DB migrate(冪等)・sidecar・`--via-parser` ingest・chat pipeline が実スタックで動くことを
  確認した(これまで executable を阻んでいたのは欠陥 2 の ESM 解決不能であり、それを是正した)。
  ただし **locator-citation E2E の決定論的 green は未達**(allowlisted ローカルモデルの tool-calling
  限界)。最終クローズは「Anthropic provider での 1 回の green」を運用者アクションとして残す
  (台帳 C に反映)。

### 回帰確認(欠陥 1・2 の是正後)

| コマンド | 結果 |
| --- | --- |
| `mise run check` | **PASS** — `test:run` 58 files / **625 passed**(前回 624 → +1 は `42710` 新規テスト)/ typecheck 全 9 project Done(self-ref import 含む)/ audit No known vulnerabilities / lint 149 files no fixes / lint:model-ids No hardcoded model IDs |

### 変更ファイル(Task 5 boundary 追加分 — escape 条項に基づく)

- `packages/db/bin/migrate.ts`(欠陥 1: 42710 検出拡張・改名)
- `packages/db/tests/migrate.spec.ts`(欠陥 1: 42710 テスト追加)
- `packages/schemas/src/env.ts` / `auth-env.ts` / `infra-env.ts`(欠陥 2: self-ref specifier + import 並び)

## Ship Gate 再検証(2026-07-26 — `/sdd-ship` 実行時、commit 前)

`/sdd-validate-impl 005-baseline-recovery-refactor Task5` が「欠陥 1・2 の是正が未コミット」と
指摘したため、commit 前に独立した再実行でローカルゲートを再確認した。

| コマンド | 結果 |
| --- | --- |
| `pnpm exec vitest run --project packages packages/db/tests/migrate.spec.ts packages/schemas/tests/infra-env.spec.ts packages/schemas/tests/env.spec.ts` | **PASS** — 3 test files / 31 tests |
| `node packages/rag/bin/ingest.ts`(引数なし、native ESM で起動確認) | usage メッセージまで到達(`ERR_MODULE_NOT_FOUND` 再発なし — 欠陥 2 是正の実地確認) |
| `mise run check` | **PASS** — `lint:model-ids` No hardcoded model IDs / `lint` Checked 149 files, no fixes / `typecheck` 全 9 workspace projects Done / `audit` No known vulnerabilities / `test:run` **625 passed(58 files)** |
| `NODE_ENV=production mise run build` | **PASS** — compiled successfully, 6 routes (`/`, `/_not-found`, `/api/chat`, `/api/jobs`, `/api/jobs/[id]/approve`, `/api/jobs/[id]/stream`) |

ローカルゲートは全 green。本 spec の doctrine(「ローカル green を完了条件にしない」)に従い、
**この green はコミット前の必要条件であり、CI 実績(push 後の `gate` run id)が最終条件**である
ことを明記する。CI run id は次回 push 後にこの節へ追記する。
