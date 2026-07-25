# 005-baseline-recovery-refactor — PDCA Check

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
