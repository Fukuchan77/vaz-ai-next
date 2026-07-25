# 005-baseline-recovery-refactor — PDCA Do

## Task 1: CI ゲートの回復(R1)

### 1.1 棚卸し

`pnpm install`(既に up to date)→ `pnpm audit --audit-level=moderate --json` で
2 件の high advisory を再確認(node_modules は既にインストール済みの状態で開始 — spec 起票時の
「未インストール」前提は本セッションでは成立せず、実解決版を直接確認できた):

| Advisory | Package(実解決版) | vulnerable | patched | 経路(実測) |
| --- | --- | --- | --- | --- |
| GHSA-r28c-9q8g-f849 | `postcss@8.5.16` | `<=8.5.17` | `>=8.5.18` | `next`/`next-auth`/`inngest`(prod)+ `vite`/`vitest`(dev) 経由、既存 `postcss@<8.5.10` override の射程外 |
| GHSA-mh99-v99m-4gvg | `brace-expansion@2.1.2` | `<=5.0.7` | `>=5.0.8` | `minimatch`(`openapi-typescript>@redocly/openapi-core` と `inngest>...>gaxios>rimraf>glob` の両経路、dev-only)経由、既存 `brace-expansion@>=2.0.0 <2.1.2: ^2.1.2` override は 2.x 系内のみで patched major(5.x)に届かない |

`pnpm why postcss` / `pnpm why brace-expansion` で「Found 1 version」= 両方ともツリー全体が単一の
解決版に dedupe されていることを確認(=「別の 2.x 依存線」は現状存在しない)。

### 1.2 override 是正(tier 3)

- `postcss@<8.5.10` → `postcss@<8.5.18`(セレクタを patched 境界へ拡大)、target は `^8.5.18` に変更。
  実解決 `postcss@8.5.22` を確認。
- `brace-expansion@>=2.0.0 <2.1.2` は**セレクタは変更せず**(実際の依存者 `minimatch@^2.0.1`/
  `^2.0.2` の宣言範囲と重なるのはこのセレクタのみ — plan.md が想定した「5.x 系の新規セレクタ追加」を
  試したが、`^2.0.1` の要求範囲とは重ならず無効だったため採用せず)、target のみ `^2.1.2` → `^5.0.8`
  に変更(pnpm override は major を跨いで強制解決できる)。実解決 `brace-expansion@5.0.8` を確認。
- 両エントリのコメントを `docs/dependency-policy.md` §3 の規約(vulnerable range / upstream /
  GHSA-ID / patched / 撤去条件)に合わせて更新。

### 1.3 ignoreGhsas 退避の要否判断

`pnpm install` が新 target(`postcss@^8.5.18` → 8.5.22 解決、`brace-expansion@^5.0.8` → 5.0.8 解決)
をエラーなく解決した(`minimumReleaseAge`(1440 分)未達での失敗は発生しなかった)。したがって
tier 4(`auditConfig.ignoreGhsas`)への退避は不要と判断。`minimumReleaseAge` 自体は変更していない。

### 1.4 `docs/dependency-policy.md` §6 更新

`postcss@<8.5.10` 行を supersede(本 spec で判断を下したため「対象外」文言を撤去し、新セレクタ・
新根拠・撤去条件を記載)。`brace-expansion@>=2.0.0 <2.1.2` 行の撤去条件を新 target(`^5.0.8`)に
即して更新。表見出しの検証日を 2026-07-25(spec 005 再検証)に更新。

### 1.5-1.6 `py:check` の pytest collection 修復(test-first で検証)

**RED→GREEN の再現手順(重要な発見を含む)**:

1. 最初に `rm -rf .venv && uv sync && uv run pytest` を実行 → **green(61 passed)**。
   spec の前提(`ModuleNotFoundError: No module named 'app'`)が再現しなかった。
2. 原因調査: `uv run python -c "import sys; print(sys.path)"` で `sys.path[0]` が
   rootdir(`services/agent`)であることを確認 → ローカルシェルの `PYTHONPATH=.` が
   既に rootdir を注入しており、バグをローカルで隠していた(グローバル shell 環境由来、
   このリポジトリの設定ではない)。
3. `mise.toml` が `uv = "0.9"` を pin している一方、ローカル `uv`(`which uv`)は
   mise の "latest" インストール(0.11.32)を指していた版違いも確認したが、これは今回の
   再現には無関係だった(pinned 0.9.30 でも `PYTHONPATH` が漏れていれば green になることを確認)。
4. **実際の CI ログを取得して原因を確定**: `gh run view 30100905550 --log-failed` で
   2026-07-24T14:25:49Z の実際の失敗を確認:
   `ImportError while loading conftest ... tests/conftest.py:30: from app.eval.llama import
   PydanticAIJudgeLLM / ModuleNotFoundError: No module named 'app'`。CI ランナー(GitHub Actions,
   ubuntu-latest)には `PYTHONPATH` 汚染が無いため、そちらが正しい再現環境だった。
5. `env -u PYTHONPATH` でローカル環境変数を除去して再現 → **RED(ModuleNotFoundError 再現)を確認**。
6. `[tool.pytest.ini_options]` に `pythonpath = ["."]` を追加(`[tool.uv] package = false` は維持)。
7. 同じ `env -u PYTHONPATH` の下で再実行 → **GREEN(61 passed)を確認**。
8. `services/agent/README.md` の `uv run pytest` 節に rootdir 実行前提の注記を追加。
9. `uv.lock` を `grep '^name = "app"'` で確認 → 0 件。サードパーティ `app` モジュールとの衝突なし
   (plan.md Error Handling の懸念は該当せず)。

**学び(pdca act.md へ引き上げ候補)**: ローカル shell の環境変数汚染(今回は `PYTHONPATH=.`)は
CI 実行環境と異なる「見えないローカル優位」を作り、004 と同型の「ローカル green はCI green を
保証しない」を再演しうる。再現テストは `env -u <該当変数>` で疑わしい環境変数を明示的に除去してから
行うべき。

### 1.7 検証ゲート

- `pnpm audit --audit-level=moderate` → `No known vulnerabilities found`(exit 0)
- `pnpm exec vitest run` → 574 passed(54 test files)。004 記録の 573 passed/1 skipped から
  1 件増(既存のskipped扱いテストが安定してpassした可能性 — Task 1 はテストファイルを一切
  変更していないため、この差は Task 1 の変更由来ではない。Task 3 の refactor-only 件数照合の
  ベースラインとして 574 passed / 0 skipped を採用する)。
- `NODE_ENV=production mise run build` → `next build` 完走(compiled successfully, 6 routes)。
- `mise run check`(lint + typecheck + test:run + audit + lint:model-ids)→ 全 green。
- `env -u PYTHONPATH mise run py:check` → ruff all checks passed / pyright 0 errors / pytest 61 passed。
- `git diff --stat mise.toml` → 差分ゼロ(`[tasks.check]` の依存構成不変を確認、R1.5)。

## Task 2: DB baseline の起票(R2)

### 2.1 採番 rename

`git mv packages/db/drizzle/0000_add_locator.sql packages/db/drizzle/0001_add_locator.sql`
(内容無変更 — plan.md Decisions の採番判断どおり、同一プレフィックスのまま baseline を
差し込むと辞書順が逆転するため rename を選択)。

### 2.2 `0000_baseline.sql` の導出

`packages/db/src/schema.ts` を読み、6 テーブル(`document`/`chunk`/`embedding`/`job`/`job_event`/
`audit_log`)+ 2 enum(`job_status`/`job_event_type`)+ `CREATE EXTENSION IF NOT EXISTS vector` を
手書きで導出。`chunk.locator` は baseline に含めず(`0001_add_locator.sql` が追加する delta との
二重定義を避ける — plan.md Components の設計どおり)。drizzle-kit が生成する形式(タブ区切り・
二重引用符識別子)に合わせてフォーマットし、`packages/db/tests/schema-ddl.spec.ts` のパーサが
安定して解析できるようにした。

### 2.3 ドリフト検出テスト(RED→GREEN を実証)

`packages/db/tests/schema-ddl.spec.ts` を新設。DB 接続なしで `drizzle/*.sql` を正規表現ベースの
パーサでモデル化し、`drizzle-orm` の `getTableColumns`/`getTableConfig` から得た `schema.ts` 側の
モデルと突合する(table/enum 名・enum 値順序・列の名前/型/NOT NULL/DEFAULT有無・FK の
参照先+ON DELETE、および index/CHECK は名前の存在のみ)。

**RED の実証**: 実装完了後、`0000_baseline.sql` の `"source" text NOT NULL,` を一時的に
`"source" text,` に書き換えて再実行 → `document: columns ... match schema.ts` が
`AssertionError: expected false to be true`(notNull 不一致)で失敗することを確認した
(テストが drift を実際に検出できることの立証)。直後に元へ戻し GREEN を再確認。

初回実装時点でテストは一発 GREEN だった(22 tests)— `0000_baseline.sql` を `schema.ts` から
直接書き起こしたため。上記の意図的な mismatch 注入で「意味のあるテストである」ことを別途検証した。

### 2.4-2.5 `packages/db/bin/migrate.ts` + pure part テスト

`packages/rag/bin/ingest.ts` の composition-root 様式(`import.meta.main` ガード、pure 部分の
export)を踏襲。純粋部分: `listMigrationFiles`(辞書順ファイル列挙)/ `pendingMigrations`
(未適用差分)/ `resolveDatabaseUrl`(fail-fast)/ `createConsoleLogger`(単一 Logger、Task 3 の
`@vaz/config` 統合対象には未加入 — Task 2 の boundary は `packages/db/bin/migrate.ts` を含むが
Task 3 の boundary には含まれないため、今回は ingest.ts と同型の複製とした)/
`isDuplicateTableError`(Postgres `42P07` 検出)/ `describeUntrackedExistingDatabase`
(fail-loud メッセージ)。I/O 境界(`applyMigrations`、`_vaz_migration` 追跡下の 1 ファイル
1 トランザクション適用)はユニットテスト対象外(2.10 で実 DB 検証)。

`packages/db/tests/migrate.spec.ts` を新設、上記 6 つの純粋関数を 14 tests でカバー
(一発 GREEN)。`packages/db/package.json` に `pg`/`@types/pg` を devDependency で追加
(`@vaz/rag` と同じバージョン指定)、`migrate` script を追加。`vitest.config.ts` の coverage
除外に `packages/db/bin/migrate.ts` を 1 行追加(既存 `apps/worker/src/start.ts` と同様の
process entry 除外)。

### 2.6 `mise.toml`

`[tasks."db:migrate"]`(`run = "pnpm --filter @vaz/db run migrate"`)を `[tasks.audit]` の直後に追加。

### 2.7 虚偽記述の是正

- `packages/db/src/schema.ts:22-23` — 「Migrations own the `CREATE EXTENSION vector` DDL」を、
  `0000_baseline.sql` の実在と `mise run db:migrate` という適用手段を指す文へ書き換え。
- `docker-compose.yml:9-11` — 同旨の記述をパッケージ名 `@vaz/rag` → `@vaz/db` の是正込みで書き換え。
- `CLAUDE.md` / `AGENTS.md` — grep で確認(`drizzle-kit is still un-adopted — DDL is applied
  manually` は 0 件)。spec.md の記述どおり、working tree で既に目標文面へ是正済み(コミット
  `22dc6a2`「docs: record @vaz/db schema ownership and db:migrate as DDL apply path」で反映
  済みと判断)— no-op 確認のみで変更不要だった。

### 2.8 ADR-0002

`docs/adr/0002-ddl-migration-strategy.md` を新設。ADR-0001 の節構成(Status/Date/仕様根拠/
Context/Decision/Consequences/再トリガー条件/References)に倣い、drizzle-kit 非採用の継続判断、
ドリフトテストの機械保証の射程(名前・型・NOT NULL・DEFAULT有無・FK ON DELETE まで、index
method/op-class と CHECK 式の意味等価は人手レビュー)、`db:migrate` の冪等性スコープ(fresh DB /
`_vaz_migration` 追跡下のみ、既存 DB は fail-loud)を明記。

### 2.9 検証ゲート

- `pnpm exec vitest run --project packages packages/db/tests` → 3 test files / 51 tests passed
  (既存 `schema.spec.ts` 15 + 新規 `schema-ddl.spec.ts` 22 + 新規 `migrate.spec.ts` 14)。
- `pnpm exec biome check --write` で新規 3 ファイルのフォーマット崩れ(2 space→タブ整形/
  import 順序)を自動修正。
- `mise run check`(lint + typecheck + test:run + audit + lint:model-ids)→ 全 green。
  `pnpm exec vitest run` は **610 passed(56 test files)**。Task 1 完了時点の 574 passed から
  +36(`schema-ddl.spec.ts` 22 + `migrate.spec.ts` 14)— 新規モジュールのみの純増で、既存テストの
  減少はゼロ。
  (途中、`pnpm -r run typecheck` の `@vaz/evals` ステップが 1 度 `SIGTERM` で落ちたが、`mise run
  check` の全タスクを並列起動した際のリソース競合による一時的なもので、単独実行
  (`pnpm --filter @vaz/evals run typecheck`)では即時成功。再実行した `mise run check` では
  再現せず全 green だったため、コード起因ではないと判断。)

### 2.10 docker 到達性検証(honest-skip)

`docker info` を実行 → **到達不能**(`failed to connect to the docker API at
unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial
unix /var/run/docker.sock: connect: no such file or directory`)。docker CLI 自体は存在する
(Rancher Desktop 由来、`/Users/k-fukuda/.rd/bin/docker`)が daemon が起動していない。
R2.6 の honest-skip 手順に従い、`docker compose up -d db` → `mise run db:migrate` →
`psql` での `vector(768)`/2 enum 実在確認は**本セッションでは実施不能**として記録する
(理由: docker daemon 未起動)。ドリフトテスト(DB 不要)は 2.3/2.9 で実施済みのため、
R2 の機械保証は満たしている。docker 到達可能な環境での実施は運用者アクションとして残す。
