# 005-baseline-recovery-refactor — Technical Plan

散文は日本語、識別子・型・パス・コードは英語(`spec.json` `language: ja`)。

## Summary

再検証(2026-07-25、`18edd7ab`)が確定した 4 分類のうち、分類 1〜3 を消化し分類 4 の一部を
単一化する 5 フェーズ:

1. **M1 ゲート回復(R1)** — `pnpm audit` の新規 high advisory 2 件を override の射程是正で解消、
   `py:check` の pytest collection 失敗を `pythonpath` 設定で解消。**CI 実績としての green** を
   到達点とする(ローカル green は 004 の誤りの再演になる)。
2. **M2 DB baseline(R2)** — 存在しない baseline DDL を `schema.ts` から導出してコミットし、
   `mise run db:migrate` と DDL↔schema ドリフト検出テストを追加、虚偽記述 4 箇所
   (`schema.ts` / `docker-compose.yml` / `CLAUDE.md` / `AGENTS.md`)を是正、
   drizzle-kit 非採用を ADR-0002 に記録。
3. **M3 seam 単一化(R3)** — console-`Logger` 4 重複を `@vaz/config` の単一実装へ、infra env
   5 箇所を `@vaz/schemas` の Zod スキーマへ。refactor-only。
4. **M4 docs 整合(R4)** — README 全面刷新、broken link 解消、`.env.example` 補完、
   review doc の状態注記。
5. **M5 台帳確定(R5)** — spec.md 台帳 + pdca。

コード挙動の変更は**ゼロ**である。M1 は依存解決と設定、M2 は既存 DDL の明文化(実 DB の状態を
変えるのではなく、既に手で作られていた状態を SQL として起票する)、M3 は同一挙動の実装統合、
M4/M5 は文書。

## Architecture Overview

### M2 後の DB provisioning 経路

```
packages/db/src/schema.ts  ← 正本(NFR-4: SQL はここから導出する)
        │
        │ 導出(手書き) + ドリフト検出テストで整合を機械保証
        ▼
packages/db/drizzle/
  0000_baseline.sql        ← 新規: CREATE EXTENSION / 2 enum / 6 table / index / FK / CHECK
  0001_add_locator.sql     ← 既存 0000_add_locator.sql を rename(適用順を辞書順で自明にする)
        │
        │ mise run db:migrate(辞書順・冪等)
        ▼
   PostgreSQL + pgvector(docker compose の `db`)
```

- **採番**: 既存ファイルを `0001_` へ rename する。`0000_` を空けて baseline を差し込む案
  (`0000_baseline.sql` + 既存を `0000_add_locator.sql` のまま)は同一プレフィックスで
  辞書順が `0000_add_locator` < `0000_baseline` となり **適用順が逆転する**ため不採用。
  rename は git 履歴上も内容無変更の move として追える。
- **冪等性**: 適用済みファイル名を記録する内部テーブル(`_vaz_migration`)を migrate CLI が
  管理する。`CREATE EXTENSION IF NOT EXISTS` のような個別の冪等化に頼らない(`CREATE TABLE` は
  `IF NOT EXISTS` を付けると列の差異を黙って無視するため、テーブル単位の冪等化はドリフトを隠す)。

### M3 後の依存グラフ(変化なし — 既存リーフに寄せるだけ)

```
@vaz/schemas (leaf)                    @vaz/db (leaf)
  ├─ env.ts         aiEnvSchema
  ├─ auth-env.ts    authEnvSchema
  ├─ infra-env.ts   infraEnvSchema     ← 新規(第 3 の同形スキーマ)
  └─ env-helpers.ts emptyToUndefined   ← 新規(3 スキーマ共有の内部 helper)
        │
        ▼
@vaz/config (準リーフ: 実装を持つ)
  └─ logger.ts  createConsoleLogger  ← 新規(単一実装)
        │
   ┌────┴────┬──────────┬───────────┐
   ▼         ▼          ▼           ▼
apps/web  apps/worker  @vaz/rag(bin) @vaz/evals
```

- **なぜ `Logger` 実装が `@vaz/config` なのか**: `@vaz/schemas` は「Zod 契約と型のみ」という
  既存の役割(`deps.ts` は `Logger` interface を宣言するが実装を持たない)を壊さないため。
  `@vaz/config` は既に `resolveModel` / `initTelemetry` という実装を持つ準リーフで、
  全 composition root から到達可能。dep graph の向きは変わらない。
- **なぜ infra env が `@vaz/schemas` なのか**: `aiEnvSchema` / `authEnvSchema` と同形の Zod
  スキーマであり、`@vaz/rag` の bin(`@vaz/config` 経由でも届くが)と `apps/*` の両方から
  参照される。リーフに置くのが最短で反転が無い。

## Components

### M1: ゲート回復(R1)

#### R1.1 — `pnpm audit` の 0 件化

対象 advisory(CI run 30148997568 / job 89656022418、2026-07-25T07:16:27Z のログで確定):

| Advisory | Package | vulnerable | patched | 経路(実測) | 既存 override の問題 |
| --- | --- | --- | --- | --- | --- |
| GHSA-r28c-9q8g-f849 | `postcss` | `<=8.5.17` | `>=8.5.18` | dev のみ 8 本(`@vitejs/plugin-react>vite>postcss`、`@vitest/coverage-v8>vitest>@vitest/mocker>vite>postcss` 等) | `postcss@<8.5.10: ^8.5.15` は 8.5.18 を強制しない |
| GHSA-mh99-v99m-4gvg | `brace-expansion` | `<=5.0.7` | `>=5.0.8` | `openapi-typescript>@redocly/openapi-core>minimatch>brace-expansion`、`apps__worker>inngest>@opentelemetry/auto-instrumentations-node>…>minimatch>brace-expansion` | `brace-expansion@>=2.0.0 <2.1.2: ^2.1.2` は 2.x 系のみ。今回は 5.x 系 |

手順は `docs/dependency-policy.md` §2〜§4 のとおり:

1. `pnpm audit --audit-level=moderate --json` で棚卸し、`pnpm why postcss` / `pnpm why brace-expansion`
   で実解決版と依存範囲を確認する(**本 spec 執筆時点では `node_modules` 未インストールのため
   実解決版は未確定 — 実装時に必ず再導出する**)。
2. tier 3(override)で対応:
   - `postcss`: セレクタを patched 境界に合わせる(`postcss@<8.5.18` → `^8.5.18`)。既存
     `postcss@<8.5.10` 行は新セレクタに包含されるため統合するか、コメントで経緯を残して置換する。
   - `brace-expansion`: 5.x 系のエントリを**追加**する(`brace-expansion@>=5.0.0 <5.0.8` → `^5.0.8`)。
     既存 2.x エントリは別の依存線(`@redocly>minimatch` の 2.x 解決)に効いているため残す。
     セレクタを `<5.0.8` のように広く取ると 2.x 消費者を 5.x へ引き上げてしまうため範囲を切る。
3. patched 版が `minimumReleaseAge`(1440 分)未達で解決できない場合のみ tier 4
   (`auditConfig.ignoreGhsas`)へ退避し、**`minimumReleaseAge` は変更しない**(§5 の禁止事項)。
   その場合は `ignoreGhsas` の撤去条件(= 24h 経過後に override へ移す)を §6 表に書く。
4. コメント規約(§3)に従って各 override に `# <package>: <vulnerable-range> (via <upstream>) has
   <vuln-summary> (<GHSA-ID>); patched in <patched-version>. <撤去条件>.` を付ける。

#### R1.3 — `py:check` の pytest collection 修復

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
pythonpath = ["."]   # ← 追加
```

- 根拠: `[tool.uv] package = false` のため `uv sync` は project 自身を venv へ入れない。
  pytest の `importmode=prepend` は `tests/conftest.py` の basedir(`tests/`)を `sys.path` に
  入れるだけで project root は入らず、`from app.eval.llama import …` が解決しない。
  `pythonpath = ["."]`(pytest 7+ の組み込み機能、追加プラグイン不要)は rootdir を
  `sys.path` 先頭へ加える。
- `package = false` を維持する理由: sidecar は配布物ではなくアプリケーション。`package = true` に
  すると build backend の指定とビルド成果物の管理が要り、`Dockerfile`(uv ベース)にも影響する。
- 併せて `services/agent/README.md` の `uv run pytest` 記述に「rootdir から実行する
  (`pythonpath = ["."]` が前提)」旨を追記する。

#### R1.4 — CI 実観測

`lint` / `tests` / `python` の 3 workflow は push で自動起動する(`python` は
`services/agent/**` 変更で path-filter 発火 — 本 spec は `pyproject.toml` を触るため発火する)。
run の conclusion を pdca/check.md に run id 付きで記録し、`gate` の初 green をもって
台帳 C-2 のブロック解除を宣言する。

### M2: DB baseline(R2)

#### `packages/db/drizzle/0000_baseline.sql`(新規)

`schema.ts` から導出する(NFR-4)。含む要素:

- `CREATE EXTENSION IF NOT EXISTS vector;`
- `CREATE TYPE job_status AS ENUM ('pending','running','suspended','completed','failed');`
- `CREATE TYPE job_event_type AS ENUM ('step-start','tool-call','token','completion','error');`
- `document`(`id uuid PK default gen_random_uuid()`, `source text NOT NULL`, `metadata jsonb`,
  `ingested_at timestamptz NOT NULL DEFAULT now()`)
- `chunk`(+ FK `document_id → document.id ON DELETE CASCADE`、`ordinal integer NOT NULL`、
  `content text NOT NULL`、`locator text` は **baseline には含めない** — `0001_add_locator.sql`
  が追加する delta なので二重定義しない)
- `chunk_document_id_idx` / `chunk_document_ordinal_uq`
- `embedding`(`chunk_id uuid PK` + FK `ON DELETE CASCADE`、`vector vector(768) NOT NULL`、
  `dim integer NOT NULL`、`provider`/`model text NOT NULL`)、CHECK `embedding_dim_fixed (dim = 768)`、
  `embedding_vector_hnsw` HNSW index(`vector_cosine_ops`)
- `job` / `job_event`(+ `job_event_job_id_ts_idx`)/ `audit_log`(FK `ON DELETE SET NULL` +
  `audit_log_job_id_idx`)
- `gen_one_random_uuid` 相当: Drizzle の `defaultRandom()` は `gen_random_uuid()` を出力する
  (PostgreSQL 13+ 組み込み。`pgcrypto` は不要)

**locator の扱いが重要**: baseline に `locator` を含めると `0001_add_locator.sql` の
`ALTER TABLE ADD COLUMN` が二重適用で失敗する。baseline は「locator 導入前の状態」を表し、
delta がそれを進める — これが履歴として正しい形であり、ドリフトテストは
「baseline + 全 delta の適用結果」と `schema.ts` を比較する(baseline 単体とは比較しない)。

#### `packages/db/tests/schema-ddl.spec.ts`(新規)

DB 接続なしの純テキスト検証:

1. `node:fs` で `drizzle/*.sql` を辞書順に読み、`CREATE TABLE` / `ALTER TABLE … ADD COLUMN` /
   `CREATE TYPE` を解析して「適用後のスキーマ像」を組む。
2. `drizzle-orm` の `getTableName` / `getTableColumns` で `schema.ts` の各 table から
   実際の DB 列名・型を取り出す(`getTableColumns(chunk).locator.name === "locator"` の形)。
3. 両者を突合して差分ゼロを assert する。突合は **名前だけでなく列の実体まで**含める
   (名前一致だけでは drizzle-kit 非採用の唯一の代償装置として不足するため — これが本テストの
   存在意義):
   - table 集合 / enum 名・値列
   - 各列の **名前・型(`getTableColumns(t).<col>.getSQLType()` ↔ SQL の型トークン、`vector(768)` 含む)・
     NOT NULL・DEFAULT の有無**
   - FK の **参照先と ON DELETE 挙動**(`chunk`/`embedding` の `CASCADE`、`audit_log` の `SET NULL`)
4. `EMBEDDING_DIM` が SQL の `vector(768)` と CHECK の `= 768` に一致することを assert
   (既存 `packages/db/tests/schema.spec.ts` の `EMBEDDING_DIM` 検証様式を踏襲)。
5. index の存在(名前)と CHECK の存在(名前)まで。**CHECK 式そのものの意味等価判定はしない** —
   ここが本テストの**意図的な射程限界**で、この線引き(何を機械保証し、何を人手レビューへ委ねるか)を
   test docstring と ADR-0002 に明記する。曖昧にしないことが drizzle-kit 非採用の正当化の条件である。

これが drizzle-kit を採らない代償(生成による整合保証の欠如)の埋め合わせ装置である
(spec.md Clarifications: この装置が無いなら drizzle-kit 採用のほうが正しい)。**したがって突合の射程は
「名前のみ」ではなく上記の列実体・FK 挙動まで含める必要がある**(名前一致だけの版は代償装置として不足で、
その状態なら drizzle-kit を採るべきだったことになる)。

#### `packages/db/bin/migrate.ts` + `mise run db:migrate`(新規)

`packages/rag/bin/ingest.ts` の composition-root 様式をそのまま踏襲する:

- `#!/usr/bin/env node`、`import.meta.main` ガード、pure 部分(ファイル列挙・順序決定・
  未適用判定)を export してユニットテスト可能にする。
- `pg` の `Pool` を **bin が所有**する(004 R2.2 の「`@vaz/db` の runtime code は pg を持たない、
  pool は composition root 所有」は維持 — bin 自体が composition root)。`pg` は
  `@vaz/db` の **devDependency** として追加する(`src/**` は依然 pg 非依存で、
  `packages/rag` が bin のために `pg` を持つ先例と同型。ただし rag は `dependencies` に置いている
  ため、`@vaz/db` を「schema-only パッケージ」として保つ意図を明示するために devDependency を選ぶ)。
- 内部テーブル `_vaz_migration(name text primary key, applied_at timestamptz default now())` を
  `CREATE TABLE IF NOT EXISTS` で用意し、未記録のファイルのみ 1 トランザクションずつ適用する。
- package script は `@vaz/rag` の `"ingest": "node bin/ingest.ts"` と**同一形式**にする
  (Node 24 は TS を native に type-strip するため loader 指定は不要):
  ```json
  "scripts": { "migrate": "node bin/migrate.ts" }
  ```
  mise task は `[tasks.lint]` 等の 1 行 `run` 様式で:
  ```toml
  [tasks."db:migrate"]
  run = "pnpm --filter @vaz/db run migrate"
  description = "Apply packages/db/drizzle/*.sql to DATABASE_URL in lexical order (idempotent)"
  ```
- **カバレッジ除外**: bin の非 pure main(`packages/db/bin/migrate.ts`)は他の process/CLI main
  (`apps/worker/src/start.ts`、`packages/evals/src/nightly.ts`)と同様に `vitest.config.ts` の
  coverage 除外へ 1 行追加する。pure 部分(ファイル列挙・順序決定・未適用判定・既存 DB 検出メッセージ)は
  export して `migrate.spec.ts` で単体テストするため、除外しても保護は失われない。これを怠ると未テストの
  main 本体が分母に入り、M3 検証の lines/functions ≥ 80(R3.5/NFR)を割りうる。
- **代替案(不採用)**: `psql -f` をループする shell task。`psql` のローカル存在に依存し
  (compose 経由なら `docker compose exec` が必要)、冪等性の記録先も持てないため退ける。
  `drizzle-orm/node-postgres/migrator` も不採用: drizzle-kit が生成する `meta/_journal.json` を
  前提とするため、drizzle-kit 非採用と両立しない。

#### 虚偽記述の是正(R2.4)+ ADR-0002(R2.5)

- `packages/db/src/schema.ts:22-23`: 「Migrations own the `CREATE EXTENSION vector` DDL
  (docker-compose provisions the server, 8.1)」→ baseline の実在と適用手段(`mise run db:migrate`)を
  指す文へ。
- `docker-compose.yml:9-11`: 同旨。「all schema live in the Drizzle migration (@vaz/rag, Task 8.3)」の
  パッケージ名も `@vaz/db`(004 で移動済み)へ是正する。
- `CLAUDE.md` / `AGENTS.md`: 「drizzle-kit is still un-adopted — DDL is applied manually」の記述を、
  `mise run db:migrate` の導入で「手動 psql が唯一の適用手段」でなくなるため是正する。真になる内容
  (適用手段 = `mise run db:migrate`、drizzle-kit は依然非採用で baseline は手書き + ドリフトテスト)へ
  書き換える。**この 2 件を落とすと 004 R3(README を境界に含めず drift を取り落とした失敗)を再演する**
  ため、DDL 適用手段に触れる doc 系記述はすべて R2.4 の射程に含める(spec.md R2.4)。
- `docs/adr/0002-ddl-migration-strategy.md`(新規): Context(baseline 不在の発見)/ Decision
  (手書き baseline + ドリフトテスト + `db:migrate`、drizzle-kit 不採用)/ Consequences
  (手書きの追随コストはドリフトテストが機械検出する。**ただし機械保証の射程は table/列名・列型・
  NOT NULL・DEFAULT・FK の ON DELETE までで、index/CHECK 式の意味等価は人手レビュー**という線引きを明記。
  また **`db:migrate` の冪等性は fresh DB もしくは `_vaz_migration` 追跡下の再実行に対して成立し、
  手動 psql で作られ `_vaz_migration` 不在の既存 DB へは fail-loud する**ことを設計意図として記す)/
  再トリガー条件。ADR-0001 の節構成に倣う。

### M3: seam 単一化(R3)

| 対象 | 現状(実測) | 変更後 |
| --- | --- | --- |
| console-`Logger` | 4 実装: `apps/web/src/app/api/chat/route.ts:46`(インライン)/ `apps/worker/src/start.ts:46`(`createConsoleLogger`、export 済み)/ `apps/worker/src/main.ts:272`(`consoleLogger` const、`buildWorkerDeps` の既定)/ `packages/rag/bin/ingest.ts:51`(`createConsoleLogger`、`fields ?? ""` 版) | `@vaz/config` の `createConsoleLogger()` 1 実装。4 箇所が import。`apps/worker/src/start.ts` の export は互換のため再 export するか、呼び出し元(テスト)を書き換える — `apps/worker/tests/start.spec.ts` / `packages/rag/tests/ingest-cli.spec.ts` が両方 export をテストしているため、**テスト側を単一実装のテストへ寄せる**(重複テストも 1 本にする) |
| `DATABASE_URL` | 3 実装: `apps/web/src/lib/db.ts:23`(`resolveWebDbEnv`)/ `apps/worker/src/start.ts:32`(`resolveWorkerEnv` 内)/ `packages/rag/bin/ingest.ts:41`(`resolveDatabaseUrl`)。エラーメッセージは 3 種類とも文面が異なる(例示 URL が `db:5432` と `localhost:5432`) | `@vaz/schemas/infra-env` の `infraEnvSchema` + `parseInfraEnv()`。**文面の差異は現行どおり維持**(呼び出し元が文脈付きメッセージを足せるよう、スキーマは「必須である」ことだけを担保し、各 root が `catch` で文脈を付ける)。既存テストのメッセージ assertion を壊さないことが refactor-only の判定基準 |
| `REDIS_URL` | 2 箇所で既定値 `redis://redis:6379` を重複定義: `apps/web/src/app/api/jobs/[id]/stream/route.ts:34`(`resolveRedisUrl`)/ `apps/worker/src/start.ts:40` | 同スキーマの `.default("redis://redis:6379")` に集約 |
| `emptyToUndefined` | 2 実装(同一内容): `packages/schemas/src/env.ts:30` / `auth-env.ts:24` | 新設 `packages/schemas/src/env-helpers.ts` に単一定義し、`env.ts` / `auth-env.ts` / `infra-env.ts` の 3 スキーマが import する(フラット構成に倣った同形の内部 helper module。新パターンは持ち込まない) |
| `AGENT_SERVICE_URL` | 2 実装(`packages/rag/src/ingest/index.ts:312` fail-fast / `packages/evals/src/tier2.ts:170` fail-soft) | **統合しない**。両 docstring に意図的差異を明記(`tier2.ts:161-170` は既に述べているので、`ingest/index.ts` 側に対称の記述を足す) |

**refactor-only の立証方法**: 変更前に `pnpm exec vitest run` の件数(004 記録では 573 passed /
1 skipped)を取り、変更後に「重複テストの統合による減少分」以外の増減が無いことを示す。減少した
テストは tasks.md に件数と理由を記録する。

### M4: docs 整合(R4)

- **README.md**: 英語節(L9-132)と日本語節(L134-181)の双方を書き直す。`### Project Structure` は
  AGENTS.md の「Monorepo structure」ツリーと矛盾しない形にする(**AGENTS.md を正本とし README は
  その要約**という関係を明記して、次の乖離を防ぐ)。Tasks 表は `mise.toml` を正本として
  `check` / `lint:model-ids` / `py:check` / `openapi:gen` / `db:migrate` を追加。
  Git Hooks 節は 5 ステップ。CI 節は 5 workflow。
- **broken link**: L181 の `docs/MIGRATION_TO_NEXT.md` は不存在。同種の記録は
  `specs/001-vaz-ai-update/` が担っているのでそこへ差し替える(実体ファイルは新規作成しない)。
- **`.env.example`**: コードが読む 19 件 + SDK/compose が読む分(`AUTH_SECRET`、
  `AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`、`AUTH_GOOGLE_ID`/`_SECRET`、`INNGEST_BASE_URL`/
  `_EVENT_KEY`/`_SIGNING_KEY`/`_DEV`)。既存の日本語コメント様式(「省略時は …」)を踏襲。
  秘密値はプレースホルダ。**モデル ID を書く行は `ANTHROPIC_MODEL` の既存行のみ**で、
  `scripts/forbid-model-ids.sh` の走査対象(`apps`/`packages`/`services`)外なので現状どおり安全。
- **`docs/agentic-engineering-review.md`**: 冒頭に「状態注記」ブロックを置き、§2.2 表に
  「解消: spec 002 <根拠>」列を足す(または各行末に追記)。§3 の RV-1〜RV-7 も同様に消化済みを
  明示する。§1(一次情報レビュー)は不変。

### M5: 台帳確定(R5)

spec.md「Out of Scope / Future Work」が正本(004 の台帳を supersede)。pdca は 004 と同じ
3 点構成(`do.md` / `check.md` / `act.md`)。

## Error Handling / Edge Cases

- **`minimumReleaseAge` による patched 版の解決不能**(R1.1): 24h 未達なら tier 4
  (`ignoreGhsas`)へ退避し、撤去条件(24h 後に override 化)を §6 表に書く。`minimumReleaseAge` を
  下げる/無効化する対処は取らない。
- **override 追加による回帰**: dev-only 経路(`vite`/`vitest`)への postcss 引き上げは
  テストランナー自体の挙動に触るため、`pnpm install` 後に `pnpm exec vitest run` と
  `NODE_ENV=production mise run build` の両方を通す(`docs/dependency-policy.md` §4 の順序)。
- **baseline SQL と実 DB の乖離**(R2.3 の冪等性スコープ): 既に手動 `psql` で作られた開発 DB は
  `_vaz_migration` テーブルを持たないため、`db:migrate` の初回実行が baseline を**再適用しようとして
  失敗する**。これは R2.3 が「無条件冪等ではない」と定義した意図的挙動である。migrate CLI は
  「テーブルが既に存在する」エラーを検出したら
  「既存 DB は `_vaz_migration` へ手動で baseline を記録済みとしてマークするか、DB を作り直す」旨を
  fail-loud で案内する(黙ってスキップしない)。手順は ADR-0002 と README に書く。
- **`locator` の二重定義**(R2.1): baseline には含めない(Components 参照)。ドリフトテストは
  「baseline + 全 delta」で比較するので、片方だけ見て「列が足りない」と誤検出しない設計にする。
- **`pythonpath` 追加の副作用**(R1.3): rootdir が `sys.path` 先頭に入ることで、`app` と同名の
  サードパーティモジュールが影に入る可能性がある。`services/agent` の依存に `app` は無い
  (`uv.lock` で確認する)ため実害なし。確認結果を pdca に記録する。
- **`Logger` 統合による出力差**(R3.1): `packages/rag/bin/ingest.ts` 版は `fields` 未指定時に
  空文字列を渡す(`console.info(message, "")`)。統一版は引数を省く。CLI 出力の末尾空白が消える
  だけで、これを検証しているテストは無い(`ingest-cli.spec.ts` は 4 メソッドの存在と委譲のみ)。
  tasks.md に「意図的な出力差」として記録する。

## Verification

| Phase | 実施 | 委譲 |
| --- | --- | --- |
| M1 | `pnpm install` → `pnpm audit --audit-level=moderate`(0 件)→ `pnpm exec vitest run` → `NODE_ENV=production mise run build`。`services/agent` で `rm -rf .venv && uv sync && uv run pytest`(fresh venv での再現)→ `mise run py:check` | **CI の 3 workflow green(R1.4 — 委譲ではなく必須の到達点)**。uv 不在環境なら pytest 修正の妥当性は設定根拠で示し、CI 実走を判定に使う |
| M2 | `pnpm exec vitest run --project packages packages/db/tests`(ドリフトテスト)。`docker compose up -d db` → `mise run db:migrate` → `psql "$DATABASE_URL" -c "\d chunk" -c "\dT+ job_status"` | docker 不在なら R2.6 の honest-skip(ドリフトテストは DB 不要なので**必ず実施する**) |
| M3 | `pnpm exec vitest run`(件数の増減説明)/ `pnpm exec vitest run --coverage`(lines/functions ≥ 80)/ `mise run check` | — |
| M4 | `grep -rn "src/lib/ai\|MIGRATION_TO_NEXT" README.md` 残存 0 / md link 走査で broken 0 / `.env.example` のキー集合 ⊇ コードの `process.env` キー集合 | — |
| M5 | 台帳の全項目に検証日と根拠があること(セルフレビュー)/ フェーズ毎 adversarial review(002 レトロの規約) | — |

## Decisions(採用/不採用)

- **migration 採番**: 既存を `0001_add_locator.sql` へ rename【採用】/ baseline を
  `0000_baseline.sql` として既存名を残す【不採用: 同一プレフィックスで辞書順が逆転】。
- **DDL の生成手段**: 手書き baseline + ドリフト検出テスト【採用】/ drizzle-kit 採用【不採用:
  既存スタンスと refactor-only 性を同時に壊す。ADR-0002 に再トリガー条件を記録】/
  baseline SQL のコミットのみで適用は手動 psql【不採用: fresh clone の再現性が回復しない】。
- **migrate の実装**: `pg` を持つ bin CLI【採用】/ `psql -f` ループの shell task【不採用:
  psql 依存・冪等記録が持てない】/ `drizzle-orm` の migrator【不採用: drizzle-kit の journal 前提】。
- **`Logger` 単一実装の置き場**: `@vaz/config`【採用】/ `@vaz/schemas`【不採用: 契約のみを置く
  既存の役割分担を壊す】/ 新パッケージ `@vaz/logging`【不採用: 1 関数のためにパッケージを増やす】。
- **infra env の置き場**: `@vaz/schemas/infra-env`【採用、`aiEnvSchema`/`authEnvSchema` と同形】/
  既存 `env.ts` へ相乗り【不採用: `auth-env.ts` を分けた「関心が違えばスキーマを分ける」判例に反する】。
- **`AGENT_SERVICE_URL`**: 統合しない【採用、意図的差異を docstring で固定】。
- **構造分割(deep import / 大型ファイル / evals tsconfig)**: 本 spec では着手しない【採用】。
  トリガー付きで台帳 A-11〜A-13 へ登録する。
- **README**: 全面刷新【採用】/ 部分修正【不採用: root `src/` 構成が残ると現行との判別が付かない】。
