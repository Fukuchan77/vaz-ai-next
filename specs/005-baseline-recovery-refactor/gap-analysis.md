# 005-baseline-recovery-refactor — Implementation Gap Analysis

散文は日本語、識別子・型・パス・コードは英語(`spec.json` `language: ja`)。
**判断ではなく情報と選択肢**を提供する。

> 状態: 本 feature は spec 004 の台帳と申し送りをコード実態・CI 実績と突合した再検証
> (2026-07-25、対象コミット `18edd7ab`)の結果として起票された。004 の gap-analysis は
> 「ドキュメントが現実より**悲観的**だった」(保留と書かれた項目が実は解消済み)ことを発見と
> したが、本 spec の発見は逆で、**ドキュメントが現実より楽観的**だった — 「green」と記録された
> ゲートが CI で赤、「migration が所有する」と書かれた DDL が存在しない。
>
> **検証環境の制約(重要)**: 本 gap-analysis は `node_modules` 未インストールの環境で作成された。
> したがって `pnpm audit` / `vitest` / `tsc` のローカル実走は**行っていない**。代わりに
> (a) GitHub Actions の実 run ログ、(b) ソースコードの静的読解、(c) `git`/`grep`/`find` による
> 実測を根拠とする。実装時は Task 1.1 で advisory の再現と実解決版の再導出から始めること。
>
> **ライブ再検証(2026-07-25 追記 — `/sdd-validate-gap` 実走)**: 上記制約下で作られた本 doc を、
> `node_modules` + `services/agent/.venv` が存在する環境で裏取りした。**結果は全 finding が実測と一致**
> (下表の分類は不変):
> - `pnpm audit --audit-level=moderate` → high 2 件を実測再現(1.1): `postcss`(vulnerable `<=8.5.17` /
>   patched `>=8.5.18`、GHSA-r28c-9q8g-f849、dev 経路 8 本)、`brace-expansion`(vulnerable `<=5.0.7` /
>   patched `>=5.0.8`、GHSA-mh99-v99m-4gvg)。既存 override はどちらも射程外(1.1 のとおり)。
> - `mise run typecheck` 全プロジェクト Done / `mise run lint` biome 141 files clean /
>   `mise run test:run` **54 files・574 passed・0 skipped**(004 基準 573 passed + 1 skipped から skip 1 件が
>   解消)= 「TS ゲートは green、赤は `audit` と `py-check` のみ」を実測確認(1.4 / NFR-3 の前提)。
> - CI 実績も再確認: run `30100905550`(python)= failure、run `30148997568`(tests、`gate` 含む)= failure、
>   両者とも headSha `18edd7ab`(1.4)。
>
> **要注意の挙動 1 件(1.3)**: ローカル `uv run pytest --collect-only` は **成功する**(`61 tests collected`、
> 002 の 57 から増加)。これは既存 `.venv`(`sys.path[0]` が cwd=`services/agent`)+ ローカル pytest が CI の
> `pytest==9.1.1` と異なることによる**見かけの green** で、まさに本 spec が問題にする「ローカル green が
> CI red を隠す」罠の実例。根本原因(`pyproject.toml` の `pythonpath` 不在、`package = false`)は静的確認済みで、
> fresh 環境の CI red(run 30100905550、`conftest.py:30` `ModuleNotFoundError: No module named 'app'`)は不変。
> **「ローカルで pytest が通ったから 1.3 は解消済み」と誤読しないこと** — 判定は CI 実績で行う(NFR-3)。
>
> **軽微な行ズレ 1 件**: 3.1 の chat route インライン logger は `apps/web/src/app/api/chat/route.ts:46`
> (本文の `:47` は off-by-one)。他の 3 実装(`start.ts:46` / `main.ts:272` / `ingest.ts:51`)は一致。

## Analysis Summary

- **R1 の 2 件はどちらも「設定の射程不足」で、コード欠陥ではない**。advisory 2 件は override
  セレクタが patched 境界/メジャー系列を外している問題、pytest 失敗は `pythonpath` 欠落。
  どちらも `docs/dependency-policy.md` の既存 runbook と pytest の組み込み機能で閉じる。
- **R2 が唯一の新規構築**。ただし「新機能」ではなく**既に手で作られていた DB 状態の明文化**で、
  実行時挙動は変わらない(NFR-4: `schema.ts` が正本、SQL はその導出物)。
- **R3 は純粋な統合**。4 実装 → 1、5 箇所 → 1 スキーマ。新語彙を足さず、置き場所は既存の
  役割分担(`@vaz/schemas` = 契約、`@vaz/config` = 実装を持つ準リーフ)に載せる。
- **R4 は 004 R3 の境界漏れの回収**。004 は AGENTS.md/CLAUDE.md を境界としたため README 等が
  残った。004 act.md 自身の学び(「『保留』を書いた場所は解消コミットの `_Boundary:_` に含める」)を
  ドキュメント整合にも適用すると、**「現構成を記述する場所」を全て境界に含める**必要があった。
- **推奨アプローチは Extend(既存パターン踏襲)**: override コメント規約、bin CLI の
  composition-root 様式、Zod env スキーマの 3 つ目、mise task の 1 行 `run` 様式、ADR の節構成 —
  すべて既存判例に完全に載る。**新規発明が必要なのは baseline SQL と ドリフト検出テストのみ**。

## Per-Requirement Gap Table

凡例: ✅ 既存コードで充足 / 🔧 一部存在(拡張要) / 🆕 新規構築 / 👁 観測・記録のみ / ❌ 宣言と実態が矛盾

### Requirement 1 — CI ゲートの回復

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 1.1 | ❌→🔧 | run 30148997568 / job 89656022418 で `audit` ステップが exit 1、`2 vulnerabilities found / Severity: 2 high`。`postcss` GHSA-r28c-9q8g-f849(vulnerable `<=8.5.17`/patched `>=8.5.18`、dev 経路 8 本)と `brace-expansion` GHSA-mh99-v99m-4gvg(vulnerable `<=5.0.7`/patched `>=5.0.8`)。既存 override(`postcss@<8.5.10: ^8.5.15`、`brace-expansion@>=2.0.0 <2.1.2: ^2.1.2`)はどちらも射程外。**004 check.md は同日「`pnpm audit` ✅ 0 件」と記録している** — ローカル実行と CI の間に新規 advisory が landed した |
| 1.2 | 🔧 | `docs/dependency-policy.md` §6 表は 4 行(postcss/sharp/js-yaml/brace-expansion)。postcss 行は「本 spec の対象外 — 維持のみ、新規判断は行わない」と明記しており、本 spec で判断を下すため supersede が必要 |
| 1.3 | ❌→🔧 | run 30100905550 / job 89506390834: ruff `All checks passed!` / pyright `0 errors, 0 warnings, 0 informations` の後、`uv run pytest` が `ImportError while loading conftest … tests/conftest.py:30 … ModuleNotFoundError: No module named 'app'` で exit 4。`pyproject.toml` は `[tool.uv] package = false` + `[tool.pytest.ini_options]` に `asyncio_mode` のみ。002 pdca/do.md(594-709)と check-final.md(「pytest 57 passed」)はローカル `.venv` 状態に依存した green |
| 1.4 | 👁 | 003 以降 `gate` ジョブは存在するが green の実績が確認できない(直近 run 30148997568 の `gate` は `Check required jobs succeeded` で failure)。`python` workflow は 004 で新設され、初回発火(run 30100905550)が failure |
| 1.5 | ✅ | `mise.toml` `[tasks.check].depends = ["lint","typecheck","test:run","audit","lint:model-ids"]`、`py:check` は非依存 — 変更不要(維持を明記するのみ) |

### Requirement 2 — DB provisioning の回復

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 2.1 | 🆕 | `packages/db/drizzle/` の中身は `0000_add_locator.sql`(3 行コメント + `ALTER TABLE "chunk" ADD COLUMN "locator" text;`)のみ。リポジトリ全体の `CREATE TABLE` 検索ヒットは 0(spec 記録内の言及を除く)。`schema.ts` は 6 テーブル + 2 enum + 5 index(うち 1 unique)+ 1 CHECK + `vector(768)` を宣言 |
| 2.2 | 🆕 | ドリフト検出の先例はある(`schema.ts:130-134` が `jobEventTypeEnum` ↔ `@vaz/schemas` の `jobEventTypeSchema` の drift-guard test を docstring で言及)が、**SQL ↔ schema.ts のドリフトテストは存在しない** |
| 2.3 | 🆕 | `mise.toml` に DB 関連 task は 0。適用は手動 `psql`(003 pdca/do.md)。migration runner も無し |
| 2.4 | ❌ | `packages/db/src/schema.ts:22-23`「Migrations own the `CREATE EXTENSION vector` DDL」/ `docker-compose.yml:9-11`「the `CREATE EXTENSION vector` DDL and all schema live in the Drizzle migration (@vaz/rag, Task 8.3)」— 前者は**存在しない migration** を指し、後者はさらに**004 で移動済みのパッケージ名**を指している(二重の stale) |
| 2.5 | 🆕 | `docs/adr/` は 0001 のみ。drizzle-kit 非採用は 004 spec.md Clarifications に短い記載があるが ADR 化されていない(台帳 A-9 も「トリガー: 次の DDL 変更」のまま) |
| 2.6 | 👁 | 実走は環境依存([E] 節)。本セッション環境に docker デーモン無し |

### Requirement 3 — infra seam の単一化

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 3.1 | 🔧 | console-`Logger` 4 実装を grep で確定: `apps/web/src/app/api/chat/route.ts:46`(インライン、`AgentDeps["logger"]` 型注釈)/ `apps/worker/src/start.ts:46`(`createConsoleLogger`、export)/ `apps/worker/src/main.ts:272`(`consoleLogger` const、`buildWorkerDeps` の既定値)/ `packages/rag/bin/ingest.ts:51`(`createConsoleLogger`、export、`fields ?? ""` 版)。契約 `Logger` は `packages/schemas/src/deps.ts:43` に単一定義 |
| 3.2 | 🔧 | `DATABASE_URL` fail-fast 3 箇所 + `REDIS_URL` 既定値 2 箇所(spec.md 分類 3-2 の行番号)。いずれも `z` を通さない素の `env.X?.trim()`。`@vaz/schemas` には既に同形の判例が 2 つある(`aiEnvSchema`/`authEnvSchema`)ので**新規パターンではなく 3 つ目** |
| 3.3 | 🔧 | `emptyToUndefined` が `packages/schemas/src/env.ts:30` と `auth-env.ts:24` に同一実装で 2 重 |
| 3.4 | ✅(意図)/ 🔧(記述) | `packages/evals/src/tier2.ts:161-170` の docstring が既に「ingest CLI の fail-fast とは異なり」と差異を明記。`packages/rag/src/ingest/index.ts:311-318` 側に対称の記述が無いだけ |
| 3.5 | 👁 | 004 の基準値は 54 files / 573 passed / 1 skipped、coverage lines 88.56% / functions 87.38%。本 spec は重複テスト統合による**減少**を伴うため、増減の説明が必須 |

### Requirement 4 — ドキュメント整合

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 4.1 | ❌ | README `### Project Structure`(L80-101)は `src/app/`・`src/lib/ai/{env,provider,chat-schema}.ts`・`src/features/chat/`・`tests/` を記述。CLAUDE.md は「legacy root `src/`/`tests/` の移行は完了、`apps/web` が唯一の正本、root にアプリソースは無い」と明記 — **正面から矛盾**。monorepo/worker/jobs/RAG/auth/sidecar の記述はゼロ |
| 4.2 | ❌ | (a) L45/L153 が `src/lib/ai/env.ts` を参照(実体は `packages/schemas/src/env.ts`)。(b) Tasks 表(L64-78)に `check`/`lint:model-ids`/`py:check`/`openapi:gen` が不在。(c) L107/L167 の pre-commit が 4 ステップ(**004 R5.2 が 5 ステップ化済み**)。(d) L121-126 の CI 節が lint+tests のみ(実在は 5 workflow) |
| 4.3 | 🔧 | Getting Started(L34-41)は `mise install` → `pnpm install` → `cp .env.example .env.local` → `mise run dev` のみ。`docker compose up -d` の言及なし(AGENTS.md は「RAG ingest / job / approval には必須」と明記) |
| 4.4 | ❌ | L181 の `docs/MIGRATION_TO_NEXT.md` は不存在(md link 全走査で broken 1 件・これのみ) |
| 4.5 | 🔧 | `.env.example` は 5 キー(`AI_PROVIDER`/`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`/`OLLAMA_BASE_URL`/`OLLAMA_MODEL`)。コードが `process.env` から読むのは 19 キー。差分 14 件 + SDK/compose 読みの `AUTH_*`/`INNGEST_*` |
| 4.6 | ❌ | `docs/agentic-engineering-review.md` §2.2 は V-1〜V-7 を現在形の「ギャップ(指摘一覧)」、§3 は RV-1〜RV-7 を未着手の「リファクタリング計画(優先度順)」として記述。実際は 7 件すべて実装済み(`prompt.ts:44` `CHAT_SYSTEM_PROMPT` / `run-metrics.ts:16` `runStopReasonSchema` + `env.ts:24` `CHAT_TOKEN_BUDGET` / `docs/context-budget.md` + `prepareStep` seam / `GOLDEN_SET` 20 件 + `packages/evals/README.md` / `docs/agentops.md` / `docs/adr/0001-mcp-position.md` / `supervisor-verify.spec.ts`)。**この doc は 004 spec.md 冒頭の棚卸し対象リスト(「ADR・agentops・context-budget・spikes」)に載っていない** = 未棚卸しの source |

### Requirement 5 — 台帳の更新

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 5.1 | 🔧 | 004 spec.md の台帳(A 10 / B 3 / C 3)を全件再検証済み。状態変化は A-9(成立)/ C-2(前提ブロック)/ C-3(反転)の 3 件 |
| 5.2 | 🆕 | 構造分割 3 項目は 004 台帳に不在。うち大型ファイル分割は 004 Clarifications が `pr-gate.ts` について「代替案(pure 関数抽出)はより綺麗だが diff が大きい」と見送りを記録しているが、台帳項目としては登録されていない |
| 5.3 | 🆕 | `apps/worker/src/start.ts` の `requiresApprovalForKind: () => false` と `ApprovalPanel.tsx:13-17` は両方 docstring で inert の意図を説明済み。台帳 B には未収録 |
| 5.4 | 👁 | 004 act.md 申し送り 1 は「ローカルスタック保持者による実走」に委譲されていたが、**R2 完了まで構造的に実行不能**(DB スキーマを作る手段が無い)だったことが本再検証で判明した |

## Options Considered(要点)

- **`postcss` override の書き方**: (A) 既存 `postcss@<8.5.10` を `postcss@<8.5.18` に置換【推奨】/
  (B) 新エントリを追加して 2 行にする — B は同一パッケージに 2 セレクタが並び「どちらが効くか」の
  読解コストを生む。A は 1 行で patched 境界を表す。ただし**旧 advisory(GHSA-qx2v-qp2m-jg93)の
  経緯コメントを失わない**こと(コメントは統合して両 GHSA を併記する)。
- **`brace-expansion` の系列**: (A) 5.x 用エントリを追加して 2.x を残す【推奨】/ (B) セレクタを
  `<5.0.8` に広げて 1 本化 — B は 2.x 消費者(`@redocly>minimatch` 系)を 5.x へ引き上げ、
  メジャー跨ぎの解決を強制するため回帰リスクがある。
- **pytest の import 解決**: (A) `pythonpath = ["."]`【推奨、pytest 組み込み・追加依存なし】/
  (B) `[tool.uv] package = true` + build backend 指定 — B は Dockerfile とビルド成果物管理に
  波及し、「sidecar は配布物ではない」という位置づけも変わる / (C) `tests/__init__.py` を置いて
  rootdir 挿入を誘導 — C は pytest の import mode に依存する暗黙的な手で、意図が読めない。
- **migration 採番**: (A) 既存を `0001_add_locator.sql` へ rename + `0000_baseline.sql`【推奨】/
  (B) baseline を `0000_baseline.sql`、既存は `0000_add_locator.sql` のまま — **B は辞書順で
  `0000_add_locator` < `0000_baseline` となり適用順が逆転する**ため即却下。
- **migrate の実装**: (A) `pg` を使う bin CLI + `_vaz_migration` 記録【推奨、`packages/rag/bin/ingest.ts`
  の判例に載る】/ (B) `psql -f` ループの shell task【psql のローカル存在に依存、冪等記録が持てない】/
  (C) `drizzle-orm/node-postgres/migrator`【drizzle-kit 生成の `meta/_journal.json` 前提で、
  drizzle-kit 非採用と両立しない】。
- **`Logger` 単一実装の置き場**: (A) `@vaz/config`【推奨】/ (B) `@vaz/schemas`【「契約のみ」の
  役割分担を壊す】/ (C) 新パッケージ `@vaz/logging`【1 関数のためのパッケージ増設】。
- **README**: (A) 全面刷新【推奨】/ (B) 部分修正 — B は root `src/` の記述が残る限り読者が
  現行との判別を付けられない。
- **構造分割(deep import / 大型ファイル / evals tsconfig)**: (A) 台帳へ送る【推奨】/
  (B) 本 spec に含める — B は R3 の「挙動変更ゼロを diff で示せる」境界を超え、赤い CI を
  green に戻すという本 spec の主目的を薄める。
