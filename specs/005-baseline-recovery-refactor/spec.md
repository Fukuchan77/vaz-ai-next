# 005-baseline-recovery-refactor

## Project Description

spec 004(`004-debt-closeout-refactor`)は「保留項目台帳の確定」を成果とし、pdca/check.md で
**全 AC 充足・全ゲート green** を宣言してクローズした。004 act.md は次回棚卸しのルールとして
「棚卸しは **spec 記録 ⇔ コード実態の突合**を必須とする(ドキュメント同士の突合では『実は解消済み』
も『実は壊れている』も検出できない)」を自ら掲げた。

本 spec はそのルールを 004 自身に適用した再検証(2026-07-25、対象コミット `18edd7ab`)の結果として
起票される。検証は台帳 A(トリガー待ち 10 件)/ B(意図的設計 3 件)/ C(運用者アクション 3 件)と
004 act.md の申し送り 5 件の全件を、コード実態・CI 実績・依存グラフと突合した。結果は 4 分類:

1. **004 の「green」はローカル環境限定の主張だった** — 同一コミットの CI で 2 ジョブが赤。
   `tests`/`audit` は `pnpm audit` が新規 high advisory 2 件(`postcss` / `brace-expansion`)を検出、
   `python`/`py-check` は pytest が `ModuleNotFoundError: No module named 'app'` で collection 失敗。
   両者により `gate` が赤で、台帳 C-2(branch protection 新規作成)は前提を満たせずブロック中。
   004 act.md 申し送り 2「python.yml の初回発火観測」は**発火済み・結果は不合格**である。
2. **DB の baseline DDL がリポジトリに存在しない** — `packages/db/drizzle/` の中身は
   `0000_add_locator.sql`(`ALTER TABLE` 1 本)のみで、`CREATE EXTENSION vector`・6 テーブル
   (`document` / `chunk` / `embedding` / `job` / `job_event` / `audit_log`)・2 enum の DDL は
   どこにも無い。にもかかわらず `packages/db/src/schema.ts` と `docker-compose.yml`
   の 2 箇所が「migration がそれを所有する」と述べている。fresh clone から DB を provisioning する
   手段がゼロであり、RAG ingest・supervisor job・approval・locator E2E(004 act.md 申し送り 1)が
   リポジトリ単体で再現不能。**これにより台帳 A-9 の drizzle-kit トリガー「次の DDL 変更」が成立した。**
3. **004 の R3(ドキュメント整合)が境界に含めなかった乖離** — R3 は AGENTS.md / CLAUDE.md のみを
   境界としたため、README.md(spec 001 以前の root `src/` 構成のまま、broken link 1 件、
   pre-commit 4 ステップ誤記、CI 節が 2 workflow 分のみ)、`.env.example`(コードが読む 19 env に対し
   5 件のみ)、`docs/agentic-engineering-review.md`(実装済みの V-1〜V-7 を現在形の「ギャップ」として
   記述し続けている。そもそも 004 の棚卸し対象リストに載っていない)が未処理で残った。
4. **挙動変更ゼロで回収できる実測重複** — console-`Logger` 実装 4 重複、`DATABASE_URL` fail-fast
   3 重複 + `REDIS_URL` 既定値 2 重複(いずれも Zod 検証の外)、route の HTTP 定型 3 重複。

本 spec は 1〜3 を消化し、4 のうち境界が互いに素で挙動変更ゼロの部分(Logger / infra env)を
単一化する。構造分割(`apps/web` → `@vaz/worker` deep import の解消、大型ファイル分割)は diff が
大きく別トリガーに属するため、検証済みトリガー付きで台帳へ送る。

## Clarifications

### Session 2026-07-25(再検証で確定した事実と設計判断)

- **`pnpm audit` の赤は既存 override の射程不足**: `postcss@<8.5.10: ^8.5.15` は新 advisory
  GHSA-r28c-9q8g-f849(patched `>=8.5.18`)を満たさず、`brace-expansion@>=2.0.0 <2.1.2: ^2.1.2` は
  2.x 系のみを対象とするため GHSA-mh99-v99m-4gvg(vulnerable `<=5.0.7`、5.x 系)に当たらない。
  対応は `docs/dependency-policy.md` の 4 段階中 **tier 3(override)**。`minimumReleaseAge`(24h)で
  patched 版が解決できない場合のみ tier 4(`auditConfig.ignoreGhsas`)へ落とす。**どちらの場合も
  `minimumReleaseAge` そのものは下げない**(同 runbook §5 の禁止事項)。
- **`py:check` の赤は設定欠落で、コード欠陥ではない**: ruff / pyright(strict、0 errors)は green。
  `services/agent/pyproject.toml` が `[tool.uv] package = false` かつ `[tool.pytest.ini_options]` に
  `pythonpath` を持たないため、fresh `uv sync` 後の venv に project root が載らず `app` が解決しない。
  002 pdca の「57 passed」はローカル `.venv` の既存状態に依存した green だった。修正は
  `pythonpath = ["."]` の追加(`package = false` は維持 — sidecar は配布物ではない)。
- **drizzle-kit は今回も採用しない**: baseline DDL の起票でトリガーは成立したが、採用すると
  `schema.ts` を正本とする生成フローと「DDL は手動 `psql` 適用」の既存スタンス(003 pdca/do.md)を
  同時に入れ替えることになり、本 spec の refactor-only 性を壊す。代わりに **手書き baseline SQL +
  `mise run db:migrate` + DDL↔`schema.ts` ドリフト検出テスト**を採る。ドリフトテストは drizzle-kit を
  採らない代償(生成による整合保証の欠如)を機械的に埋め合わせる装置であり、これが無いなら
  drizzle-kit 採用のほうが正しい。判断と再トリガー条件は ADR-0002 として記録する。
- **`AGENT_SERVICE_URL` の 2 実装は統合しない**: `packages/rag/src/ingest/index.ts` は fail-fast
  (`--via-parser` は明示指定なので未設定は誤り)、`packages/evals/src/tier2.ts` は fail-soft
  (未設定なら tier2 ステージを無効化)という**意図的な差異**で、`tier2.ts:161-170` の docstring が
  既にそう述べている。「既存シーム優先・新語彙を足さない」規約に従い、差異の意図を docstring で
  固定するのみとし、共通化はしない。
- **infra env スキーマの置き場所は `@vaz/schemas`**: `aiEnvSchema`(`env.ts`)・`authEnvSchema`
  (`auth-env.ts`)と**同じ形**(`z.object` + `parseXxxEnv(env = process.env)` + `emptyToUndefined`)の
  第 3 のスキーマとして並べる。`@vaz/schemas` はリーフであり全 composition root から到達可能で、
  dep graph を反転させない。新パターンは持ち込まない。
- **console-`Logger` 単一実装の置き場所は `@vaz/config`**: `@vaz/schemas` は Zod 契約と型のみを置く
  パッケージ(`deps.ts` が `Logger` interface を宣言するが実装は持たない)という既存の役割分担を
  保つため、実装は `@vaz/config`(既に `resolveModel`/`initTelemetry` という「実装を持つ準リーフ」)へ
  置く。`packages/rag/bin/ingest.ts` の `fields ?? ""` 版は 3 者と出力が異なるが、CLI の視認性以外に
  依存する検証は無い(`packages/rag/tests/ingest-cli.spec.ts` は 4 メソッドの存在と委譲のみを検証)ため
  統一側に寄せる。
- **004 の台帳 B に 1 件追記する**: `apps/worker/src/start.ts` の `requiresApprovalForKind: () => false`
  と `ApprovalPanel.tsx:13-17` の inert default は「破壊的 worker specialist が現れた時点で有効化
  される」意図的な inert 配線(両者の docstring が理由を明記)。次回棚卸しが「未配線」と再フラグ
  しないよう、意図的設計として台帳 B に記録する。
- **README は全面刷新であり増補ではない**: `### Project Structure` が記述する root `src/` は
  spec 001 で消滅した構成であり、部分修正では「どこが現行か」が読者に判別できない。英語節・
  日本語節の双方を現構成(2 apps + 7 packages + Python sidecar)で書き直す。

## Scope

### In scope

- CI ゲートの回復 — `pnpm audit` の新規 advisory 2 件と `py:check` の pytest collection 失敗(R1)
- DB provisioning の回復 — baseline DDL のコミット、`db:migrate` task、ドリフト検出テスト、
  drizzle-kit 非採用の ADR 化(R2)
- infra seam の単一化 — console-`Logger` 4 重複と `DATABASE_URL`/`REDIS_URL` の Zod 圏外重複(R3)
- ドキュメント整合 — README 全面刷新、broken link、`.env.example` 補完、review doc の状態注記(R4)
- 台帳の更新 — 再検証結果の反映、A-9 の決着、B-4 の追記、新規 3 項目のトリガー付き登録(R5)

### Out of scope

- **構造分割**(台帳 A へ新規登録、R5.2): `apps/web` → `@vaz/worker/src` の 5 モジュール
  deep import 解消 / `apps/worker/src/main.ts`(550 行)・`supervisor.ts`(549 行)・
  `ingest/index.ts`(500 行)の分割 / `nightly.ts`・`pr-gate.ts` の pure 関数抽出(004 が
  「diff 増」として明示的に見送り済み)/ `@vaz/evals` への per-package tsconfig 追加
- `AGENT_SERVICE_URL` の 2 実装の統合(Clarifications のとおり意図的差異)
- drizzle-kit の採用(R2.5 で判断と再トリガー条件を ADR 化するのみ)
- トリガー未成立の台帳 A 項目すべて(A-1〜A-8, A-10 — 下記台帳参照)
- 運用者アクションの実施そのもの(C-1 Secret 追加 / C-2 branch protection 作成)。R1.4 が
  C-2 の**前提**(`gate` の初 green)までを担保し、実施は台帳に残す

## Glossary

- **baseline DDL**: 空の PostgreSQL に対して `schema.ts` 相当のスキーマを 0 から作る SQL
  (`CREATE EXTENSION` / `CREATE TYPE` / `CREATE TABLE` / index / FK / CHECK)。既存の
  `0000_add_locator.sql` はこの上に載る delta。
- **ドリフト検出テスト**: 手書き SQL と `schema.ts` の table 定義が一致していることを検証する
  ユニットテスト。drizzle-kit による生成整合の代替装置。
- **infra env**: `DATABASE_URL` / `REDIS_URL` のようにインフラ接続先を指す環境変数。
  モデル選択(`aiEnvSchema`)・IdP 選択(`authEnvSchema`)とは別の関心。
- **射程不足(override)**: `pnpm-workspace.yaml` の override セレクタ/置換版が、後から出た
  advisory の patched 範囲を満たさない状態。

## Requirements

<!--
EARS 形式(rules/ears-format.md)。受入基準は階層番号で採番し plan.md / tasks.md の
トレーサビリティキーとする。既定主語 THE VAZ platform。
-->

### Requirement 1: CI ゲートの回復(P0)

**User Story**: 保守者として、宣言済みの品質ゲートが CI で実際に green であってほしい。理由:
004 は全ゲート green を宣言したがそれはローカル実行の結果であり、同一コミットの CI では
`audit` と `py-check` が赤で `gate` が成立していない。赤の上に積む変更は検証の意味を失う。

**Acceptance Criteria**:

1.1 [E] WHEN `pnpm audit --audit-level=moderate` が実行された時, THE VAZ platform SHALL report
zero advisories。`pnpm-workspace.yaml` `overrides` は GHSA-r28c-9q8g-f849(`postcss`、patched
`>=8.5.18`)と GHSA-mh99-v99m-4gvg(`brace-expansion`、patched `>=5.0.8`)の両方に射程を合わせる。
patched 版が `minimumReleaseAge`(1440 分)で解決できない場合は `auditConfig.ignoreGhsas` へ退避し、
`minimumReleaseAge` 自体は変更しない。
1.2 [U] `docs/dependency-policy.md` §6 撤去条件表 SHALL carry a row per new/changed entry with its
撤去条件。既存 `postcss@<8.5.10` 行の「本 spec の対象外 — 維持のみ、新規判断は行わない」文言は
本 spec で判断を下したため SHALL be superseded。
1.3 [E] WHEN `uv sync` された直後の環境で `uv run pytest` が実行された時, `services/agent` の
テストコレクション SHALL succeed。`[tool.pytest.ini_options]` に `pythonpath = ["."]` を追加し、
`[tool.uv] package = false` は維持する(sidecar は配布パッケージではない)。
1.4 [E] WHEN 本 spec のブランチが push された時, `lint` / `tests`(`unit`+`audit`+`e2e`+`gate`)/
`python` の 3 workflow SHALL all conclude success、and the first green `gate` run SHALL be recorded
in pdca/check.md(台帳 C-2 のブロック解除記録)。
1.5 [U] 本 spec は `mise run check` の依存構成(`lint`/`typecheck`/`test:run`/`audit`/`lint:model-ids`)
SHALL NOT change、`py:check` を `check` の依存に SHALL NOT add(004 NFR-1 のスタンス維持)。

### Requirement 2: DB provisioning の回復

**User Story**: 開発者として、リポジトリを clone した状態から DB スキーマを作れるようにしたい。
理由: baseline DDL がリポジトリに無いため fresh clone では RAG ingest も supervisor job も
approval も locator E2E も動かせず、004 act.md 申し送り 1(E2E 実スタック実走)が構造的に
実行不能である。

**Acceptance Criteria**:

2.1 [U] `packages/db/drizzle/` SHALL contain a baseline DDL file that provisions, against an empty
database: `CREATE EXTENSION IF NOT EXISTS vector`、2 enum(`job_status` / `job_event_type`)、
6 テーブル(`document` / `chunk` / `embedding` / `job` / `job_event` / `audit_log` — DB 上の
snake_case 名。export 名は `jobEvent` / `auditLog`)、および
`schema.ts` が宣言する index・FK・CHECK・`vector(768)` 次元。baseline は locator delta より前に
適用されることが辞書順で自明になる採番にする(既存ファイルは `0001_add_locator.sql` へ rename し
baseline を `0000_baseline.sql` とする — plan.md Decisions の採番判断。旧 `0000_add_locator.sql` の
名前は rename 後は残らない)。
2.2 [U] `packages/db/tests/` SHALL contain a drift test asserting that the baseline DDL(+ 全 delta
適用後)と `schema.ts` の定義が一致すること(drizzle-kit を採らない代償の埋め合わせ)。突合は
table/enum 名 + enum 値列に加え、各列の **名前・型・NOT NULL・DEFAULT の有無**、および FK の
**ON DELETE 挙動**まで含める(名前のみの突合では代償装置として不足する)。index の存在と CHECK 式の
意味等価は射程外で人手レビューに委ね、その線引きをテスト docstring に明記する。テストは SQL テキストを
解析対象とし、DB 接続を SHALL NOT require。
2.3 [U] `mise run db:migrate` SHALL apply `packages/db/drizzle/**` を辞書順に `DATABASE_URL` へ適用する。
冪等であること — ここでいう冪等性は **fresh DB もしくは適用済みを記録する `_vaz_migration` 追跡下での
再実行が失敗しないこと**を指す(無条件の冪等ではない)。手動 `psql` で作られ `_vaz_migration` を持たない
既存 DB への初回適用は、黙ってスキップせず **fail-loud で案内する**(ドリフトを隠さないための意図的挙動。
判断は ADR-0002 に記録し、既存 DB のマーク手順は README に載せる)。
2.4 [U] 虚偽記述 4 箇所 SHALL be corrected: (1) `packages/db/src/schema.ts` の「Migrations own the
`CREATE EXTENSION vector` DDL」、(2) `docker-compose.yml` の「the `CREATE EXTENSION vector` DDL and
all schema live in the Drizzle migration」、(3) `CLAUDE.md` および (4) `AGENTS.md` の
「drizzle-kit is still un-adopted — DDL is applied manually」。(1)(2) は本 spec で初めて真になり、
(3)(4) は `mise run db:migrate` の導入で「手動 psql が唯一の適用手段」でなくなるため偽になる。
いずれも真になった内容(適用手段 = `mise run db:migrate`、drizzle-kit は依然非採用で baseline は
手書き + ドリフトテスト)へ書き換える。境界を 2 件に絞ると 004 R3(README を境界に含めず drift を
取り落とした失敗)を再演するため、DDL 適用手段に触れる doc 系記述はすべて本 AC の射程に含める。
なお **(3)(4)〔`CLAUDE.md` / `AGENTS.md`〕は本ブランチの working tree で既に目標文面へ是正済み
(未コミット)** であり、実装時は idempotent な no-op 確認(該当の虚偽文字列が既に存在しないこと)に
留める。未是正で残るのは (1)(2)〔`schema.ts:22-23` / `docker-compose.yml:9-11`〕である
(2026-07-25 再検証時点)。
2.5 [U] `docs/adr/0002-*.md` SHALL record the drizzle-kit 非採用判断: baseline を手書き + ドリフト
テストで担保する理由、drizzle-kit を採るべき再トリガー条件(例: テーブル追加を伴う機能 spec、
複数環境へのバージョン管理された migration 適用要件)。台帳 A-9 は「判断済み」へ更新する。
2.6 [E] WHEN docker 到達環境で実行された時, `docker compose up -d db` → `mise run db:migrate` →
`psql` による実在確認(`vector(768)` 列と 2 enum)SHALL be recorded in pdca/check.md
(到達不能な場合は honest-skip として理由付きで記録)。

### Requirement 3: infra seam の単一化(refactor-only)

**User Story**: 保守者として、同じ関心の実装が composition root ごとに複製されていない状態に
したい。理由: `Logger` 契約は `@vaz/schemas/deps` に単一定義があるのに実装は 4 箇所に散在し、
「env は Zod で検証する」という宣言に対し infra env は 5 箇所で素の `process.env` を読んでいる。

**Acceptance Criteria**:

3.1 [U] console-backed `Logger` の実装 SHALL exist exactly once(置き場所は `@vaz/config`)、and
現行 4 箇所 — `apps/web/src/app/api/chat/route.ts`(インライン)/ `apps/worker/src/start.ts`
(`createConsoleLogger`)/ `apps/worker/src/main.ts`(`consoleLogger` const)/ `packages/rag/bin/ingest.ts`
(`createConsoleLogger`)— SHALL consume it。R4.7 プライバシー契約(message + 明示 fields のみ)は
単一実装の docstring に集約する。
3.2 [U] infra env の解決 SHALL be a single Zod schema in `@vaz/schemas`(`aiEnvSchema` /
`authEnvSchema` と同形)、and `DATABASE_URL` の fail-fast 3 箇所(`apps/web/src/lib/db.ts` /
`apps/worker/src/start.ts` / `packages/rag/bin/ingest.ts`)と `REDIS_URL` の既定値 2 箇所
(`apps/web/src/app/api/jobs/[id]/stream/route.ts` / `apps/worker/src/start.ts`)SHALL consume it。
3.3 [U] `emptyToUndefined` SHALL exist exactly once within `@vaz/schemas`(現状 `env.ts` と
`auth-env.ts` に 2 重)。
3.4 [U] `AGENT_SERVICE_URL` の 2 実装 SHALL NOT be merged; instead each docstring SHALL state the
intentional fail-fast / fail-soft difference(既存シーム優先、新語彙を足さない)。
3.5 [U] R3 は refactor-only: 既定値・エラーメッセージ文面・fail-soft/fail-fast の振る舞いは
SHALL remain equivalent、全ユニットテスト green、coverage 閾値(lines/functions ≥ 80)維持、
テスト件数は移動/置換由来の増減のみ。

### Requirement 4: ドキュメント整合(004 R3 の取り落とし分)

**User Story**: 新規参加者・エージェントとして、README を読んだ時に現構成と矛盾しない手順を
得たい。理由: README は spec 001 で消滅した root `src/` 構成を記述し続けており、記載どおりに
辿れるファイルが存在しない。

**Acceptance Criteria**:

4.1 [U] README.md の `### Project Structure`(英語節)および対応する日本語節 SHALL describe the
current layout: 2 apps(`apps/web` / `apps/worker`)+ 7 packages(`schemas` / `db` / `config` /
`tools` / `rag` / `agents` / `evals`)+ Python sidecar(`services/agent`)。root `src/`・
`src/lib/ai/env.ts`・root `tests/` への言及は SHALL be removed。
4.2 [U] README の派生乖離 SHALL be corrected: (a) provider 節の参照先を `packages/schemas/src/env.ts`
へ、(b) Tasks 表に `check` / `lint:model-ids` / `py:check` / `openapi:gen` / `db:migrate` を追加、
(c) Git Hooks 節の pre-commit を 5 ステップ(model-ID ゲート含む)へ、(d) CI 節を実在 5 workflow
(`lint` / `tests` / `python` / `eval-pr` / `eval-nightly`)へ。
4.3 [U] Getting Started SHALL include the steps that make the stack actually runnable:
`docker compose up -d`、`mise run db:migrate`、`.env.local` に必要な最小 env。
4.4 [U] broken link `docs/MIGRATION_TO_NEXT.md`(不存在)SHALL be resolved by removing or
redirecting the reference(実体ファイルの新規作成は行わない)。
4.5 [U] `.env.example` SHALL cover every env var the code reads(現状 5 / 19)、plus the SDK-read
ones needed to boot the full stack(`AUTH_SECRET`、`AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`、
`AUTH_GOOGLE_ID`/`_SECRET`、`INNGEST_BASE_URL`/`_EVENT_KEY`/`_SIGNING_KEY`/`_DEV`)。秘密値は
プレースホルダとし、各行に用途と既定値を注記する。
4.6 [U] `docs/agentic-engineering-review.md` SHALL carry a status annotation stating that V-1〜V-7 /
RV-1〜RV-7 は spec 002 で消化済みである(根拠: `CHAT_SYSTEM_PROMPT` / `runStopReasonSchema` +
`CHAT_TOKEN_BUDGET` / `docs/context-budget.md` + `prepareStep` seam / `GOLDEN_SET` 20 件 +
`packages/evals/README.md` / `docs/agentops.md` / ADR-0001 / supervisor 検証ステップ)、and 現在形の
「ギャップ」表記 SHALL be reworded as a historical record。§1(8 手法の一次情報レビュー)は不変。

### Requirement 5: 台帳の更新

**User Story**: 保守者として、次の棚卸しが本セッションの再検証を出発点にできるようにしたい。
理由: 004 の台帳は 1 日で 3 項目(A-9 / C-2 / C-3)の状態が変わり、うち 2 件は状態が悪化した。
台帳は検証日とともに更新されなければ同じ腐り方をする。

**Acceptance Criteria**:

5.1 [U] 本 spec の「Out of Scope / Future Work」SHALL supersede 004 の台帳 with 2026-07-25 の
再検証結果: A-9 は「判断済み(ADR-0002)」、C-2 は前提ブロックとその解除、C-3 は「撤去監視」から
「射程不足の是正」への反転を含む。
5.2 [U] 構造分割 3 項目(deep import 解消 / 大型ファイル分割 / `@vaz/evals` tsconfig)SHALL be
registered in 台帳 A with verified triggers(本 spec で着手しない理由とともに)。
5.3 [U] 意図的設計 B-4(inert な承認ゲート配線)SHALL be added with its evidence。
5.4 [E] WHEN R2 が完了した時, 004 act.md 申し送り 1(locator E2E 実スタック実走)SHALL become
executable、and its result SHALL be recorded in pdca/check.md(到達不能なら honest-skip)。

### NFR

- **NFR-1**: R1〜R5 は互いに独立して着地可能(推奨順序 R1 → R2 → R3 → R4 → R5 は依存ではない)。
  実依存は 3 つのみ: (1) R5.4(locator E2E 実走)が R2 の完了を前提、(2) R4.2(b)/4.3 が R2.3 の
  task 名(`db:migrate`)を参照、(3) R5.1〜5.3 の台帳確定が R1.4 の gate green 実績を記録対象として
  前提(tasks.md 依存図の Task 6→1)。
- **NFR-2**: R3 は refactor-only — DDL 変更なし、公開シグネチャ変更は最小、実行時挙動変更なし。
- **NFR-3**: 全フェーズを通じ既存ゲート(biome / tsc / vitest / audit / lint:model-ids / py:check)
  green を維持。R1 完了後は **CI 実績としての green** が判定基準となる(ローカル green のみでは
  004 と同じ誤りを繰り返す)。
- **NFR-4**: R2 の SQL は `schema.ts` を正本とする(SQL を先に書いて schema を合わせるのではなく、
  既存 `schema.ts` から SQL を導出する)。DDL/挙動の変更は一切含めない。

## Traceability & Milestones

| Milestone | Requirements | 主担当ファイル |
| --- | --- | --- |
| M1: ゲート回復 | R1 | `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `docs/dependency-policy.md`, `services/agent/pyproject.toml` |
| M2: DB baseline | R2 | `packages/db/drizzle/*`(新), `packages/db/tests/*`(新), `mise.toml`, `packages/db/src/schema.ts`, `docker-compose.yml`, `CLAUDE.md`, `AGENTS.md`, `docs/adr/0002-*.md`(新) |
| M3: seam 単一化 | R3 | `packages/config/src/*`(新), `packages/schemas/src/*`, `apps/web/src/lib/db.ts`, `apps/web/src/app/api/chat/route.ts`, `apps/web/src/app/api/jobs/[id]/stream/route.ts`, `apps/worker/src/{start,main}.ts`, `packages/rag/bin/ingest.ts` + 各テスト |
| M4: docs 整合 | R4 | `README.md`, `.env.example`, `docs/agentic-engineering-review.md` |
| M5: 台帳確定 | R5 | 本ファイル + `pdca/*` |

> Task 分解では R5.4(locator E2E 実走)+ フェーズ毎 adversarial review を、M1〜M3 の成果に依存する
> 検証タスクとして独立の Task 5 に切り出す(M5 の台帳確定は Task 6 に対応)。

## Out of Scope / Future Work(保留項目台帳 — 検証日 2026-07-25)

004 の台帳を置き換える。各項目は 2026-07-25 にコード実態・CI 実績と突合済み。

### A. トリガー待ち(006+ 候補。トリガー成立まで着手しない)

1. **full-hybrid 移行(Pydantic AI + `VercelAIAdapter` 本線化)** — トリガー(いずれか 1 つ):
   (a) deep-research 型 multi-agent の本線要件化、(b) 応答経路内 LlamaIndex query engine の実測必要性、
   (c) 外部 SaaS 中心ツール群 + MCP 統合判断。**再検証(07-25): 未成立**。起票時は 002 spec.md の
   移行コスト台帳を初期見積りに使う。
2. **MCP 採用** — トリガー: `docs/adr/0001-mcp-position.md` の 3 基準いずれか(外部 SaaS ツール
   3 超 / 複数ホストでのツール共有 / ベンダ提供 MCP サーバ利用の決定)。**再検証(07-25): 未成立** —
   `@vaz/tools` は `createTimeCapability` / `createEmailCapability` の 2 件のみで外部 SaaS ツールは 0。
   注: ADR が参照する Hybrid Report [HR] は未コミットのまま — gateway spec 起票時に要取得。
3. **観測性/最適化(Grafana ダッシュボード・cost/latency 閾値アラート・`CHAT_TOKEN_BUDGET`
   実測再チューニング)** — **再検証(07-25): 未成立**(`docs/agentops.md` §3「未実装」節が有効)。
   起票時は 002 Req 5.3/6.1 にスコープする。
4. **コンテキスト自動 compaction(Stage 2)** — トリガー: `budget-exceeded` が stop_reason の
   支配的要因になること。**再検証(07-25): 未成立**(観測なし)。挿入点は実装済みの Stage 1
   `prepareStep` シーム(`docs/context-budget.md`)。
5. **RAG 強化** — 再ランク(Cohere Rerank 等)・ハイブリッド/グラフ RAG、LlamaParse 実呼び出し。
   **再検証(07-25): 未成立** — `services/agent/app/routes/parse.py` は `use_llamaparse=true` で 501 を
   返すまま(設計どおり)。トリガー: 機密文書の外部送信可否の運用判断。
6. **プラットフォーム/配備** — 本番コンテナ化、S2S トークン発行/検証、JWT ミドルウェア。
   **再検証(07-25): 未成立**。トリガー: 本番配備要件、または Python サービスのユーザー到達パス昇格。
7. **per-step 検証ポリシー** — トリガー: 複数 doc-gen ステップで異なる `acceptanceCriteria`/`llmVerify`
   の使い分けニーズ。**再検証(07-25): 未成立**。
8. **Renovate/Dependabot 導入** — 採否基準は `docs/dependency-policy.md` に記録済み。
   **再検証(07-25): 未成立だが判断材料が 1 件増えた** — 本 spec R1.1 が、004 クローズ翌日に
   新規 advisory 2 件で CI が赤になった実例を追加した(手動追随のコストの実測値)。
9. ~~**drizzle-kit 採用**~~ → **本 spec で決着(R2.5、ADR-0002)**。トリガー「次の DDL 変更」は
   baseline DDL の不在という形で成立し、**手書き baseline + ドリフト検出テスト**を採用して
   drizzle-kit は不採用と判断した。**再トリガー**: テーブル追加/変更を伴う機能 spec、または
   複数環境へバージョン管理された migration を適用する要件。
10. **001 由来の未着手系** — 本番課金最適化・マルチテナント・SLA 設計 / Vision・マルチモーダル入力 /
    実 IdP テナントでの OAuth 実ラウンドトリップ。**再検証(07-25): 未成立**。
11. **(新規)`apps/web` → `@vaz/worker/src` deep import の解消** — `apps/web` は
    `@vaz/worker/src` の 5 モジュール(`inngest` / `main` / `publisher` / `stores` / `audit`)を
    直参照している。AGENTS.md は「`apps/worker` は再利用可能な engine-side ライブラリ」と意図を
    宣言しているが、実体は app→app の src 直参照であり、004 R2(`@vaz/db` 分割)と同型の未完部分。
    **本 spec で着手しない理由**: engine-side ports を `packages/*` へ引き出す変更は import 書換の
    範囲が広く、R3 の refactor-only 境界(挙動変更ゼロを diff で示せる範囲)を超える。
    **トリガー**: 第 3 のホストが engine-side ports を必要とした時、または `apps/worker` の Docker
    イメージから web 専用コードを外す必要が生じた時。
12. **(新規)大型ファイルの分割** — `apps/worker/src/main.ts`(550 行、engine 非依存ポート定義 /
    承認ゲート / deps+`runJob` の 3 関心)、`packages/agents/src/supervisor.ts`(549 行)、
    `packages/rag/src/ingest/index.ts`(500 行)、および `packages/evals` の `nightly.ts`(477)/
    `pr-gate.ts`(350)の pure 関数抽出(004 が「diff 増」として明示的に見送り、両ファイルは
    coverage 除外のまま)。**トリガー**: 当該ファイルに新しい関心を追加する変更が来た時
    (その変更と同時に分割する — 単独の分割 spec は起票しない)。
13. **(新規)`@vaz/evals` への per-package tsconfig 追加** — `@vaz/evals` のみ per-package
    `tsconfig.json` を持たず、typecheck が root aggregator(`pnpm -r run typecheck`)の外で
    package.json の inline `tsc` として走る非対称。**トリガー**: `@vaz/evals` を root aggregator に
    載せる必要が生じた時、または同型の非対称が 2 件目に増えた時。

### B. 意図的設計(保留ではない — 再フラグ禁止の検証記録)

- **`data-processing` specialist の throw**(`packages/agents/src/supervisor.ts`): `operation`
  ペイロードはアプリ定義のため汎用デフォルトは存在せず、`options.specialists` override が
  正規の差し替えシーム。docstring 明記済み。**再検証(07-25): 不変**。
- **`JobStore` の最小サーフェス**(`apps/worker/src/stores.ts`: `insert` + `findOwnerUserId`):
  approve/stream ルートの現需要を完全充足。**再検証(07-25): 不変**。トリガー: ジョブ履歴/管理 UI
  要件、または completed/failed の DB 区別を要する運用需要。
- **空 allowlist 出荷**(`ADMIN_EMAILS` / `RECIPIENT_ALLOWLIST`): コミット済み許可リストの
  ガバナンス設計。**再検証(07-25): 両方とも空のまま = 設計どおり**。
- **(新規 B-4)inert な承認ゲート配線**: `apps/worker/src/start.ts` の
  `requiresApprovalForKind: () => false` と `apps/web/src/features/jobs/ApprovalPanel.tsx` の
  inert default(`() => false`)は、「破壊的 worker specialist が現れた瞬間に有効化されるよう
  suspend/resume 経路を実エンジンに登録済みにしておく」ための意図的な inert 配線(両者の docstring が
  理由を明記)。`sendEmail`(唯一の `needsApproval: true` ツール)は chat 専用で、`rag-research` は
  読取のみ、`document-generation` はツール無しの `generateText`。**未配線ではない** — 次回棚卸しは
  再フラグしない。

### C. 運用者アクション(コード外 — 現況 2026-07-25)

1. **`ANTHROPIC_API_KEY` を リポジトリ Secrets へ追加** → `eval-pr.yml` の閾値ブロック遷移、
   nightly の tier1/tier3 verdict 実観測。**現況: 未実施**(`eval-nightly` は main で success を
   継続しているが、Secret 不在時 skip 設計のため実観測ではない)。
2. **branch protection の新規作成**(`gate` を唯一の required check に) — 003 からの申し送り。
   **現況: 前提がブロックされていた** — `gate` は 2026-07-25 の run で赤(`audit` 失敗起因)。
   本 spec R1.4 が初 green を担保するので、その後に
   `gh api .../branches/main/protection -X PUT` を実施する。
3. **override 撤去監視 → 射程是正へ反転**: `sharp@<0.35.0`(next stable の依存範囲更新待ち)と
   `js-yaml@>=4.0.0 <4.3.0`(upstream 範囲更新待ち)は撤去監視のまま。一方 `postcss` と
   `brace-expansion` は**撤去ではなく射程不足**が判明(R1.1)。`docs/dependency-policy.md` §6 表を
   本 spec で更新する。
