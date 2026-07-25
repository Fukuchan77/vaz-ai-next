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

## Task 3: infra seam の単一化(R3、refactor-only)

Task 2 終了時点のベースライン: **610 passed(56 test files)**。

### 3.1 `createConsoleLogger`(test-first)

`packages/config/tests/logger.spec.ts` を先に書いて **RED を確認**
(`Cannot find module '../src/logger'`)。`packages/config/src/logger.ts` に単一実装を追加して
**GREEN(4 tests)**。既存 3 実装(`apps/web` インライン / `apps/worker/src/start.ts` /
`apps/worker/src/main.ts` の `consoleLogger` const)は `fields ? console.x(message, fields) :
console.x(message)` で同一形だったため、この形を単一実装として採用。

### 3.2 呼び出し元 4 箇所の置換

- `apps/web/src/app/api/chat/route.ts` — インライン定義を `createConsoleLogger()` 呼び出しへ。
- `apps/worker/src/start.ts` — ローカル export を削除し `@vaz/config/logger` から import
  (`apps/worker/package.json` に `@vaz/config` を dependency として追加 — 既存は
  `@vaz/agents`/`@vaz/db`/`@vaz/schemas` のみで抜けていた)。`start.spec.ts` は
  `createConsoleLogger` を直接テストしていなかったため変更不要。
- `apps/worker/src/main.ts` — モジュールレベル `consoleLogger` const を削除し
  `buildWorkerDeps` のデフォルトを `createConsoleLogger()` 呼び出しへ。
- `packages/rag/bin/ingest.ts` — ローカル `createConsoleLogger`(`fields ?? ""` 版)を削除し
  import へ。**意図的な出力差**: `fields ?? ""` が無くなり、fields 未指定時の `console.info(message,
  "")` という末尾空文字列引数が消える(plan.md Error Handling で予告済みの差異)。
  `packages/rag/tests/ingest-cli.spec.ts` から重複していた `createConsoleLogger` の
  import・`describe` ブロックを削除(単一実装のテストへ集約 — R3.1 の統合方針どおり)。

**`packages/db/bin/migrate.ts` は対象外(2.4-2.5 の記録どおり)**: `@vaz/db` は dep graph の
leaf で `@vaz/config`(consumer 側レイヤ)を import すると逆転になるため、`@vaz/schemas` への
leaf-to-leaf import は許容されるが `@vaz/config` は不可。migrate.ts はこの制約により Task 3 の
boundary から意図的に除外されている(tasks.md の boundary 記載どおり、スコープ拡大せず)。

### 3.3 `infraEnvSchema` / `parseInfraEnv`(test-first)+ 3.5 `env-helpers.ts`

`packages/schemas/tests/infra-env.spec.ts` を先に書いて **RED を確認**
(`Cannot find package '@vaz/schemas/infra-env'`)。実装:

- `packages/schemas/src/env-helpers.ts` を新設し、`emptyToUndefined`(`env.ts`/`auth-env.ts` の
  同一実装 2 重)を単一定義。`env.ts`/`auth-env.ts` はローカル定義を削除し import へ差し替え
  (既存 `env.spec.ts`/`auth-env.spec.ts` は無変更で green のまま — 純粋な移動)。
- `packages/schemas/src/infra-env.ts` を新設。`DATABASE_URL: z.string().trim().min(1)`
  (必須)/ `REDIS_URL: z.string().trim().min(1).default("redis://redis:6379")`。
  スキーマは required 性のみを担保し、呼び出し元がエラーメッセージの文脈を足す設計
  (plan.md の意図どおり)。
- **設計上の判断(plan.md に明記されていない実装詳細)**: `apps/web/src/app/api/jobs/[id]/
  stream/route.ts` の `resolveRedisUrl` は `DATABASE_URL` に一切依存しない(Redis pub/sub の
  みを使う SSE route)。これを素朴に `parseInfraEnv()` へ通すと `DATABASE_URL` 必須の検証が
  一緒に走ってしまい、ローカル shell に `DATABASE_URL` が無い状態(実測: `node -e
  'console.log(process.env.DATABASE_URL)'` → `undefined`)でこの route のテストが軒並み壊れる
  ことが判明した。`infraEnvSchema.pick({ REDIS_URL: true })` で REDIS_URL だけを取り出す
  `parseRedisUrl()` を追加してこれを回避(同スキーマの `.default(...)` を単一ソースのまま
  再利用しつつ、DATABASE_URL への artificial coupling を避ける)。

**GREEN(11 tests)を確認**。

### 3.4 呼び出し元 5 箇所の置換

- `apps/web/src/lib/db.ts` の `resolveWebDbEnv` → `parseInfraEnv(env).DATABASE_URL` を
  `try/catch` で包み、既存の一言一句同じメッセージ(`"DATABASE_URL is required (e.g.
  postgres://vaz:vaz@db:5432/vaz)"`)を再スローする。
- `apps/worker/src/start.ts` の `resolveWorkerEnv` → `parseInfraEnv(env)` の分割代入で
  `DATABASE_URL`/`REDIS_URL` の両方を一度に解決(既存メッセージ維持)。
- `packages/rag/bin/ingest.ts` の `resolveDatabaseUrl` → 同様に try/catch で既存メッセージ維持。
- `apps/web/src/app/api/jobs/[id]/stream/route.ts` の `resolveRedisUrl` →
  `parseRedisUrl(process.env)` の 1 行へ(3.3 で設計した DATABASE_URL 非依存版)。

既存テスト(`db.spec.ts`/`start.spec.ts`/`ingest-cli.spec.ts`/`jobs-stream-route.spec.ts`/
`chat-route.spec.ts`)は全てメッセージ文面 assertion を含めて無変更で **GREEN**
(167 tests / 16 files、影響範囲を絞った実行で確認)。

### 3.6 `AGENT_SERVICE_URL` の意図的差異の明記

`packages/rag/src/ingest/index.ts` の `resolveAgentServiceUrl` docstring に、
`@vaz/evals/src/tier2.ts` の `resolveTier2BaseUrlFromEnv`(fail-soft)との非対称性を明記
(tier2.ts 側は既に ingest 側への参照コメントを持っていたため、対称の記述を ingest 側へ追加)。
統合はしない(plan.md Decisions どおり)。

### 3.7 検証ゲート

- `pnpm exec vitest run` → **624 passed(58 test files)**。Task 2 終了時点の 610 passed から
  **+14**: 新規 2 ファイル(`packages/config/tests/logger.spec.ts` +4 / `packages/schemas/
  tests/infra-env.spec.ts` +11)で +15、`packages/rag/tests/ingest-cli.spec.ts` から重複
  `createConsoleLogger` テスト 1 件を削除(3.2 の統合方針)で -1。610 + 15 - 1 = 624、
  ファイル数 56 + 2 = 58 で計算どおり一致。既存テストの意図しない減少はゼロ。
- `pnpm exec vitest run --coverage` → lines 89.55%(729/814)/ functions 90.17%(202/224)、
  いずれも ≥ 80% の閾値を満たす(branches 80.03%、statements 89.44%)。
- `mise run check`(lint + typecheck + test:run + audit + lint:model-ids)→ 全 green
  (`lint:model-ids` ✅ No hardcoded model IDs / `audit` No known vulnerabilities /
  `lint` Checked 149 files, no fixes / `typecheck` 全パッケージ+`apps/web`+`apps/worker`
  Done / `test:run` 624 passed)。

### `/sdd-validate-impl` 事後レビューで検出・修正した 2 件(refactor-only 逸脱)

1. **R3.1 の字面上のギャップ**: `packages/db/bin/migrate.ts` の `createConsoleLogger` が
   単一実装から漏れている(dep-graph の leaf 制約 — `@vaz/db` は `@vaz/config` を import
   できないため 2.4-2.5 の記録どおり意図的に対象外)。docstring に理由を明記し、将来の
   読者が「なぜ複製が残るか」を即座に判別できるようにした(コード変更なし、コメントのみ)。
2. **`parseRedisUrl` の空白のみ `REDIS_URL` に対する挙動差**: 統合前は
   `env.REDIS_URL?.trim() || "redis://redis:6379"` で空白のみの値もデフォルトへ
   フォールバックしていたが、`emptyToUndefined` は厳密な空文字列のみを unset とみなすため
   統合後は空白のみの値で `ZodError` を投げてしまっていた(R3.5 の refactor-only 逸脱)。
   `packages/schemas/src/infra-env.ts` の `parseInfraEnv`/`parseRedisUrl` で `REDIS_URL` を
   `emptyToUndefined` に渡す前に `.trim()` する 1 行修正で旧挙動と同値にした。

再検証: `pnpm exec vitest run --project packages packages/schemas/tests/infra-env.spec.ts
packages/db/tests/migrate.spec.ts` → 25 passed → `mise run check` 再実行 → 全 green
(624 passed / 58 files、差分なし)→ `NODE_ENV=production mise run build` → 6 routes
compiled successfully。既存の 624 件から増減なし(コメント追記 + 1 行の trim 追加のみで
新規テストは不要 — 既存 `infra-env.spec.ts` のテストケースが空文字列ケースを既にカバーして
おり、`.trim()` は同じ入力正規化の追加ステップであるため回帰にはならない)。
