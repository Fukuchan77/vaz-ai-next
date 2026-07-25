# 005-baseline-recovery-refactor — Implementation Tasks

`plan.md` に準拠。散文は日本語、識別子・型・パス・コードは英語。

規約(002/003/004 と同一):

- `- [ ]` 未着手 / `- [x]` 完了 / `- [ ]*` 任意・後回し可。
- `(P)` = 並列実行安全(依存なし・境界が互いに素)。
- 全タスクは `_Boundary:_` と `_Depends:_` を宣言する。
- `_Requirements:_` は要件 ID のみをカンマ区切りで列挙する。
- **`_Boundary:_` には周辺必須ファイル(テスト・lockfile・doc の該当節)を先回りで含める**
  (002 レトロ規約 / 004 act.md「解消と同時に文言を消す」)。

## Task 依存図

```
Task 1(ゲート回復 R1)──→ Task 6 の C-2 記録は Task 1 の gate green 待ち
Task 2(DB baseline R2)──→ Task 5 の E2E 実走(申し送り 1)の前提
                       └─→ Task 4 の README(db:migrate 記述)の前提
Task 3(seam 単一化 R3)(P)
Task 4(docs 整合 R4)── Task 2 の後が確実(db:migrate の task 名を参照)
Task 5(E2E 実走 + adversarial review)── Task 1〜3 の後
Task 6(台帳確定・pdca)── 全結果の記録のため最後
```

NFR-1: Task 1〜3 は独立着地可能。実依存は Task 4→2(task 名参照)、Task 5→2(実行可能条件)、
Task 6→1(gate green の記録)のみ。

---

## 1. CI ゲートの回復(P0)

_Boundary:_ `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `docs/dependency-policy.md`(§6 撤去条件表),
`services/agent/pyproject.toml`, `services/agent/README.md`(pytest 実行手順の節)
_Depends:_ none
_Requirements:_ 1.1, 1.2, 1.3, 1.4, 1.5, NFR-3

- [ ] 1.1 `pnpm install` 後に `pnpm audit --audit-level=moderate --json` で棚卸しし、
  `pnpm why postcss` / `pnpm why brace-expansion` で実解決版と依存範囲を再導出する
  (CI ログの advisory 2 件が現在も再現することの確認を兼ねる。**本 spec 起票時点では
  `node_modules` 未インストールのため実解決版は未確定**)。
- [ ] 1.2 `pnpm-workspace.yaml` `overrides` を tier 3 で是正: `postcss` のセレクタを patched
  境界(`>=8.5.18`)に合わせる / `brace-expansion` の 5.x 系エントリを追加(2.x エントリは
  別の依存線に効いているため残す)。各行に `docs/dependency-policy.md` §3 のコメント規約
  (vulnerable range / upstream / GHSA / patched / 撤去条件)を付ける。
- [ ] 1.3 patched 版が `minimumReleaseAge`(1440 分)未達で解決できない場合のみ
  `auditConfig.ignoreGhsas` へ退避し、撤去条件(24h 後に override 化)を明記する。
  **`minimumReleaseAge` は変更しない**(§5 禁止事項)。
- [ ] 1.4 `docs/dependency-policy.md` §6 撤去条件表を更新: 新規/変更エントリの行追加、既存
  `postcss@<8.5.10` 行の「本 spec の対象外 — 維持のみ、新規判断は行わない」文言を supersede。
- [ ] 1.5 `services/agent/pyproject.toml` の `[tool.pytest.ini_options]` に `pythonpath = ["."]`
  を追加(`[tool.uv] package = false` は維持)。`services/agent/README.md` の `uv run pytest` 行に
  「rootdir から実行する」旨を追記。
- [ ] 1.6 `rm -rf services/agent/.venv && uv sync && uv run pytest` で **fresh venv での
  再現**を確認(002 の green がローカル `.venv` 依存だった原因を潰したことの立証)。
  併せて `uv.lock` に `app` と衝突する同名モジュールが無いことを確認(plan.md の副作用検討)。
- [ ] 1.7 検証: `pnpm audit` 0 件 → `pnpm exec vitest run` → `NODE_ENV=production mise run build`
  (`docs/dependency-policy.md` §4 の順序)→ `mise run check` → `mise run py:check`。
- [ ] 1.8 push 後に `lint` / `tests`(`unit`+`audit`+`e2e`+`gate`)/ `python` の 3 workflow の
  conclusion を run id 付きで pdca/check.md に記録し、**`gate` の初 green** を確認する(1.4)。

## 2. DB baseline の起票

_Boundary:_ `packages/db/drizzle/0000_baseline.sql`(新設),
`packages/db/drizzle/0001_add_locator.sql`(既存 `0000_add_locator.sql` から rename),
`packages/db/bin/migrate.ts`(新設), `packages/db/tests/schema-ddl.spec.ts`(新設),
`packages/db/tests/migrate.spec.ts`(新設 — pure 部分), `packages/db/package.json`(script + devDep),
`pnpm-lock.yaml`, `mise.toml`(`db:migrate`), `packages/db/src/schema.ts`(docstring L22-23),
`docker-compose.yml`(L9-11 のコメント), `docs/adr/0002-ddl-migration-strategy.md`(新設),
`AGENTS.md`(`@vaz/db` 節の migration 記述), `CLAUDE.md`(DDL 適用手段の記述)
_Depends:_ none
_Requirements:_ 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, NFR-4

- [ ] 2.1 `git mv packages/db/drizzle/0000_add_locator.sql packages/db/drizzle/0001_add_locator.sql`
  (内容無変更 — 適用順を辞書順で自明にする。plan.md Decisions の採番判断)。
- [ ] 2.2 `0000_baseline.sql` を `schema.ts` から導出して作成(NFR-4: schema.ts が正本)。
  `CREATE EXTENSION IF NOT EXISTS vector` / 2 enum / 6 テーブル / index / FK / CHECK /
  `vector(768)`。**`chunk.locator` は含めない**(`0001` が追加する delta。二重定義で
  `ALTER TABLE ADD COLUMN` が失敗する)。
- [ ] 2.3 `packages/db/tests/schema-ddl.spec.ts`: DB 接続なしのドリフト検出テスト。
  `drizzle/*.sql` を辞書順に読んで「適用後のスキーマ像」を組み、`drizzle-orm` の
  `getTableName`/`getTableColumns` で得た `schema.ts` の table/列/enum と差分ゼロを assert。
  `EMBEDDING_DIM` ↔ `vector(768)` ↔ CHECK `= 768` の一致も assert(既存
  `packages/db/tests/schema.spec.ts` の様式を踏襲)。index/CHECK は名前の存在確認まで。
- [ ] 2.4 `packages/db/bin/migrate.ts`: `packages/rag/bin/ingest.ts` の composition-root 様式
  (`#!/usr/bin/env node`、`import.meta.main` ガード、pure 部分を export)。`_vaz_migration`
  テーブルで適用済みを記録し未適用のみを 1 トランザクションずつ適用。既存 DB(手動 psql で
  作られ `_vaz_migration` を持たない)に対しては **fail-loud** で案内する(黙ってスキップしない)。
  `packages/db/package.json` に `"migrate": "node bin/migrate.ts"` と `pg`/`@types/pg` を
  **devDependency** で追加(`src/**` は pg 非依存を維持 = 004 R2.2 の意図)。
- [ ] 2.5 `packages/db/tests/migrate.spec.ts`: pure 部分(ファイル列挙・順序決定・未適用判定・
  既存 DB 検出時のメッセージ)のユニットテスト。DB 接続は張らない
  (`packages/rag/tests/ingest-cli.spec.ts` の様式)。
- [ ] 2.6 `mise.toml` に `[tasks."db:migrate"]`(`run = "pnpm --filter @vaz/db run migrate"`)。
- [ ] 2.7 虚偽記述の是正: `packages/db/src/schema.ts:22-23` と `docker-compose.yml:9-11`
  (パッケージ名 `@vaz/rag` → `@vaz/db` も含む)を、baseline の実在と適用手段
  (`mise run db:migrate`)を指す文へ。AGENTS.md / CLAUDE.md の DDL 適用記述も同一コミットで更新。
- [ ] 2.8 `docs/adr/0002-ddl-migration-strategy.md`(ADR-0001 の節構成に倣う):
  Context(baseline 不在の発見)/ Decision(手書き baseline + ドリフトテスト + `db:migrate`、
  drizzle-kit 不採用)/ Consequences / **再トリガー条件**(テーブル追加を伴う機能 spec、
  複数環境へのバージョン管理された migration 適用要件)。
- [ ] 2.9 検証: `pnpm exec vitest run --project packages packages/db/tests`(ドリフトテストは
  DB 不要なので**必ず実施**)→ `mise run check`。
- [ ] 2.10 (docker 到達環境)`docker compose up -d db` → `mise run db:migrate` →
  `psql "$DATABASE_URL" -c "\d chunk" -c "\dT+ job_status"` で `vector(768)` 列と 2 enum の実在を
  確認 → 再実行して冪等性を確認。不能なら 2.6 の [E] 節どおり honest-skip を pdca に記録。

## 3. infra seam の単一化(refactor-only)(P)

_Boundary:_ `packages/config/src/logger.ts`(新設), `packages/config/tests/logger.spec.ts`(新設),
`packages/schemas/src/infra-env.ts`(新設), `packages/schemas/tests/infra-env.spec.ts`(新設),
`packages/schemas/src/env.ts` + `auth-env.ts`(`emptyToUndefined` の単一化),
`apps/web/src/app/api/chat/route.ts`, `apps/web/src/lib/db.ts`,
`apps/web/src/app/api/jobs/[id]/stream/route.ts`, `apps/worker/src/start.ts`,
`apps/worker/src/main.ts`, `packages/rag/bin/ingest.ts`,
`packages/rag/src/ingest/index.ts`(`AGENT_SERVICE_URL` docstring のみ),
影響テスト: `apps/worker/tests/start.spec.ts`, `packages/rag/tests/ingest-cli.spec.ts`,
`apps/web/tests/{chat-route,jobs-stream-route}.spec.ts`, `packages/schemas/tests/env.spec.ts`,
各 package.json(`@vaz/config` 依存の追加), `pnpm-lock.yaml`
_Depends:_ none
_Requirements:_ 3.1, 3.2, 3.3, 3.4, 3.5, NFR-2

- [ ] 3.1 `@vaz/config` に `createConsoleLogger()` を新設(R4.7 プライバシー契約の docstring を
  ここへ集約)。単一実装のユニットテストを 1 本に統合する。
- [ ] 3.2 4 箇所を置換: `apps/web/src/app/api/chat/route.ts:47`(インライン)/
  `apps/worker/src/start.ts:46` / `apps/worker/src/main.ts:272`(`buildWorkerDeps` の既定)/
  `packages/rag/bin/ingest.ts:51`。既存 export をテストしている
  `apps/worker/tests/start.spec.ts` と `packages/rag/tests/ingest-cli.spec.ts` は
  **単一実装のテストへ寄せる**(重複テストも 1 本に)。`ingest.ts` 版の `fields ?? ""` が消えて
  末尾空白が無くなる差は**意図的な出力差**として記録する。
- [ ] 3.3 `packages/schemas/src/infra-env.ts` を新設(`aiEnvSchema`/`authEnvSchema` と同形の
  `z.object` + `parseInfraEnv(env = process.env)`)。`DATABASE_URL`(必須)/
  `REDIS_URL`(`.default("redis://redis:6379")`)。
- [ ] 3.4 5 箇所を置換: `apps/web/src/lib/db.ts:23`(`resolveWebDbEnv`)/
  `apps/worker/src/start.ts:32`(`resolveWorkerEnv`)/ `packages/rag/bin/ingest.ts:41`
  (`resolveDatabaseUrl`)/ `apps/web/src/app/api/jobs/[id]/stream/route.ts:34`
  (`resolveRedisUrl`)/ `apps/worker/src/start.ts:40`(`REDIS_URL` 既定値)。
  **既存のエラーメッセージ文面は維持**(各 root が文脈を足す形)— 既存テストの
  message assertion を壊さないことが refactor-only の判定基準。
- [ ] 3.5 `emptyToUndefined` を `@vaz/schemas` 内の 1 箇所へ(現状 `env.ts:30` / `auth-env.ts:24` の
  同一実装 2 重)。
- [ ] 3.6 `AGENT_SERVICE_URL` は**統合しない**。`packages/rag/src/ingest/index.ts:312` の docstring に
  fail-fast の意図を明記(`packages/evals/src/tier2.ts:161-170` の fail-soft 記述と対称にする)。
- [ ] 3.7 検証: `pnpm exec vitest run`(**変更前の件数を記録し、重複テスト統合による減少分以外の
  増減が無いこと**を示す)→ `pnpm exec vitest run --coverage`(lines/functions ≥ 80)→
  `mise run check`。減少したテストは件数と理由を pdca/do.md に記録。

## 4. ドキュメント整合

_Boundary:_ `README.md`(英語節 L9-132 + 日本語節 L134-181), `.env.example`,
`docs/agentic-engineering-review.md`(冒頭状態注記 + §2.2 表 + §3)
_Depends:_ Task 2(README が `mise run db:migrate` を参照するため)
_Requirements:_ 4.1, 4.2, 4.3, 4.4, 4.5, 4.6

- [ ] 4.1 README `### Project Structure`(+ 日本語節)を現構成へ全面刷新: 2 apps + 7 packages
  (`schemas`/`db`/`config`/`tools`/`rag`/`agents`/`evals`)+ `services/agent`。root `src/`・
  `src/lib/ai/env.ts`・root `tests/` の言及を除去。**AGENTS.md を正本、README はその要約**という
  関係を明記して次の乖離を防ぐ。
- [ ] 4.2 派生乖離の是正: (a) provider 節 L45/L153 の参照先を `packages/schemas/src/env.ts` へ、
  (b) Tasks 表に `check`/`lint:model-ids`/`py:check`/`openapi:gen`/`db:migrate` を追加
  (`mise.toml` を正本とする)、(c) Git Hooks 節 L107/L167 を 5 ステップ(model-ID ゲート含む)へ、
  (d) CI 節 L121-126 を実在 5 workflow(`lint`/`tests`/`python`/`eval-pr`/`eval-nightly`)へ。
- [ ] 4.3 Getting Started に `docker compose up -d` と `mise run db:migrate`、`.env.local` の
  最小 env を追加(スタックが実際に動く手順になっていること)。
- [ ] 4.4 broken link L181 `docs/MIGRATION_TO_NEXT.md` を `specs/001-vaz-ai-update/` への参照へ
  差し替える(実体ファイルは新規作成しない)。
- [ ] 4.5 `.env.example` をコードが読む 19 件 + SDK/compose が読む分(`AUTH_SECRET`,
  `AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`, `AUTH_GOOGLE_ID`/`_SECRET`, `INNGEST_BASE_URL`/
  `_EVENT_KEY`/`_SIGNING_KEY`/`_DEV`)へ補完。既存の日本語コメント様式(「省略時は …」)を踏襲、
  秘密値はプレースホルダ。
- [ ] 4.6 `docs/agentic-engineering-review.md` に状態注記を追加し、§2.2 の V-1〜V-7 と §3 の
  RV-1〜RV-7 に「解消: spec 002 <根拠>」を付す(根拠は `CHAT_SYSTEM_PROMPT` /
  `runStopReasonSchema`+`CHAT_TOKEN_BUDGET` / `docs/context-budget.md`+`prepareStep` /
  `GOLDEN_SET` 20 件+`packages/evals/README.md` / `docs/agentops.md` / ADR-0001 /
  supervisor 検証ステップ)。§1 は不変。
- [ ] 4.7 検証: `grep -rn "src/lib/ai\|MIGRATION_TO_NEXT" README.md` が 0 件 / md link 走査で
  broken 0 件 / `.env.example` のキー集合 ⊇ コードの `process.env` キー集合。

## 5. E2E 実走 + adversarial review

_Boundary:_ `specs/005-baseline-recovery-refactor/pdca/check.md`(記録のみ。コード変更が必要に
なった場合は該当ファイルを boundary に追加して個別に記録する)
_Depends:_ Task 1, 2, 3
_Requirements:_ 5.4, NFR-3

- [ ] 5.1 フェーズ毎 adversarial review(002 レトロで採択された独立防御線): 生成側と呼び出し側の
  両方を grep して「契約はあるが未配線」を探す。特に Task 3 の置換漏れ(旧
  `createConsoleLogger`/`resolveDatabaseUrl`/`resolveRedisUrl` の残存)と Task 2 の
  `0001_add_locator.sql` 参照漏れを対象にする。
- [ ]* 5.2 (docker + Ollama + sidecar 到達環境)`docker compose --profile sidecar up -d` →
  `mise run db:migrate` → `pnpm --filter @vaz/rag ingest <corpus> --via-parser` →
  `mise run test:e2e:ollama`。green なら **004 act.md 申し送り 1 と 002 act-final の M3 PENDING を
  最終クローズ**。不能なら honest-skip として不能理由(docker デーモン / Ollama / uv の不在)を
  pdca/check.md に記録。

## 6. 台帳確定・spec ドキュメント・PDCA クローズ

_Boundary:_ `specs/005-baseline-recovery-refactor/**`
_Depends:_ Task 1〜5(結果の記録)
_Requirements:_ 5.1, 5.2, 5.3

- [ ] 6.1 spec.md「Out of Scope / Future Work」台帳の確定(004 の台帳を supersede):
  A-1〜A-8/A-10 は再検証日付きで「未成立」、**A-9 は ADR-0002 で決着**、
  **A-11〜A-13 は新規登録**(deep import / 大型ファイル / evals tsconfig、トリガー付き)。
- [ ] 6.2 台帳 B に **B-4(inert な承認ゲート配線)** を追記し、B-1〜B-3 の再検証結果(不変)を記録。
- [ ] 6.3 台帳 C を更新: C-1 未実施、**C-2 は Task 1.8 の gate green でブロック解除**(実施は
  運用者アクションとして残す)、**C-3 は「撤去監視」から「射程不足の是正」へ反転**した経緯。
- [ ] 6.4 pdca/do.md(実施ログ)・check.md(検証結果 + CI run id + honest-skip 記録)・
  act.md(申し送り + Learnings→Rules 表)。**act.md には「ローカル green を完了条件にしない」を
  ルール候補として必ず含める**(本 spec の起点となった 004 の誤りの再発防止)。
- [ ] 6.5 `spec.json` の `approvals` を実際の承認状況に合わせて更新する。
