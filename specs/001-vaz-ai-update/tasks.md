# 001-vaz-ai-update — Implementation Tasks

`/sdd-tasks` により生成。`rules/tasks-generation.md` と
`rules/tasks-parallel-analysis.md` に準拠する。散文は日本語、識別子・型・パス・
コードは英語（`spec.json` `language: ja`）。

規約:

- `- [ ]` 未着手 / `- [x]` 完了 / `- [ ]*` 任意・後回し可（コア実装で受入基準は充足済み）。
- `(P)` = 並列実行安全（依存なし・境界が互いに素）。同一 wave 内でのみ判定。
- 全タスク（major/sub）は `_Boundary:_` と `_Depends:_` を宣言する。
- `_Requirements:_` は要件 ID のみをカンマ区切りで列挙する。
- Phase 1 = MVP 境界（R1.10 厳密分離）。Phase 2〜5 は各要件に 1:1 対応。
- テスト規約（Constitution P2）: `src/` のユニットロジックは Red-Green-Refactor で進める
  （失敗テストを先に書き、確認後に最小実装）。ユニットテストの `_Depends:_` はスキャフォールド
  （package.json / 型）のみを指し、実装完了を前提としない。recall@k（tier2）・E2E は性質上
  「実装後の検証」でありこの限りでない。

---

## 1. pnpm ワークスペース化と共有ツールチェーン基盤

既存の単一パッケージ構成を `apps/*` + `packages/*` のモノレポへ再編し、supply-chain
ガードと品質ゲートの土台をワークスペース対応にする（他 Phase の前提）。

_Boundary:_ `pnpm-workspace.yaml`, `tsconfig.json`, `mise.toml`, `packages/config/tsconfig.base.json`
_Depends:_ none
_Requirements:_ 1.1, 1.2, 1.9, NFR-1, NFR-2

- [x] 1.1 `pnpm-workspace.yaml` に `apps/*`・`packages/*` を追加し、既存の
  `minimumReleaseAge` / `allowBuilds`（default deny）設定を無変更で維持する。
  _Boundary:_ `pnpm-workspace.yaml`
  _Depends:_ none
  _Requirements:_ 1.1, 1.2
- [x] 1.2 root `tsconfig.json` を project references のソリューションへ変更し、
  全パッケージ共有の `packages/config/tsconfig.base.json`（React Compiler 非適用境界）を用意する。
  _Boundary:_ `tsconfig.json`, `packages/config/tsconfig.base.json`
  _Depends:_ 1.1
  _Requirements:_ 1.1, NFR-1
- [x] 1.3 `mise.toml` に `pnpm -r`/`--filter` 対応タスクと `lint:model-ids`
  （`scripts/forbid-model-ids.sh` 実行）を追加し、`git clone → pnpm install → mise run <check>` が通る配線にする。
  _Boundary:_ `mise.toml`
  _Depends:_ 1.1
  _Requirements:_ 1.8, 1.9, NFR-2

### Implementation Notes

- **単一編集境界の前方互換**: `tsconfig.json`(1.2)・`mise.toml`(1.3) は本 Phase で各 1 タスクのみが
  編集境界。後続タスクで再編集できないため、移行期(app が root)と Task 6 移設後(app が apps/web)の
  両状態で緑になる書き方が必須。`pnpm -r run`/`pnpm --filter @vaz/web` は不一致時 exit 0(no-op)、
  `typecheck` は `[ -d src ]` ガードで root tsc を移設後に自動スキップする形で吸収した。
- **ゲート配線の分離**: git hooks は現状 `pnpm exec` 直呼び(mise 非経由)で、mise 化は Task 7.3。
  よって 1.3 の mise 変更は開発者向け `mise run check`(NFR-2)に効き、自動ゲートは 7.3 まで不変。
- **[FLAG] 既存 build 不具合**(1.2 記録の再掲): `next build` が `/_not-found` prerender で失敗。
  HEAD から存在し 1.x の回帰ではない。Task 7.5 の全ゲート緑化前に要トリアージ。

---

## 2. `@vaz/schemas` 契約パッケージ（単一正本 / NFR-6）

全境界の Zod スキーマと推論型を一元管理するパッケージを新設し、既存 env / chat の
スキーマを移設、`AgentDeps` 型を定義する。

_Boundary:_ `packages/schemas/package.json`, `packages/schemas/src/env.ts`, `packages/schemas/src/chat.ts`, `packages/schemas/src/deps.ts`
_Depends:_ 1
_Requirements:_ 1.3, 1.4, 4.7, NFR-3, NFR-6

- [x] 2.1 `packages/schemas/package.json` を作成し `@vaz/schemas` として定義する。
  _Boundary:_ `packages/schemas/package.json`
  _Depends:_ 1.2
  _Requirements:_ NFR-6
- [x] 2.2 (P) `src/env.ts` に `aiEnvSchema`/`parseAiEnv` を移設する（空文字→undefined 正規化を維持）。
  _Boundary:_ `packages/schemas/src/env.ts`
  _Depends:_ 2.1
  _Requirements:_ NFR-3
- [x] 2.3 (P) `src/chat.ts` に `chatRequestSchema` を移設する。
  _Boundary:_ `packages/schemas/src/chat.ts`
  _Depends:_ 2.1
  _Requirements:_ NFR-6
- [x] 2.4 (P) `src/deps.ts` に `AgentDeps` 型（`db`/`logger`/`now` + optional な
  no-op `audit` sink）と logger 契約（INFO で raw prompt/tool I/O を既定非記録）を定義する。
  _Boundary:_ `packages/schemas/src/deps.ts`
  _Depends:_ 2.1
  _Requirements:_ 1.3, 1.4, 4.7

### Implementation Notes

- **2.1 完了**: `@vaz/schemas` は source-only(JIT)パッケージとして定義。`type: module` /
  `exports: { "./*": "./src/*.ts" }`(subpath 直参照、barrel `index.ts` は本パッケージにタスク無し
  ため未提供)/ `dependencies.zod`。consumers は `@vaz/schemas/env` 等の subpath で import する。
  wildcard export により後続の `chat`/`deps`(2.2–2.4)および Phase 2+ の `rag`/`workflows`/`eval`
  追加時も本 package.json の再編集は不要。
- **[解決] frozen mise.toml との配線衝突**: Task 1.3 の `mise run typecheck` は
  `pnpm -r run typecheck` を用い、Note で「不一致時 exit 0(no-op)」と主張していたが、これは
  **メンバー 0 件時のみ**成立する。最初のメンバー `@vaz/schemas` 追加後は「メンバー ≥1・該当
  script 0」で `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`(exit 1)となりゲートが赤化した。mise.toml は
  凍結境界(1.3)、per-package `tsconfig.json` は File Structure Plan 非掲載で作成不可のため、
  **各 source-only メンバーが `typecheck` script を持つ**(凍結 mise の不変条件が要求する形)ことで
  解決。`@vaz/schemas` は transitive 型検査(consumers 側)を明示する echo marker を採用(standalone
  `tsc` は tsconfig 不在で誤解決するため不可)。**後続 3.1 / 4.1 / 5.1 の source-only package.json も
  同様に `typecheck` script を必須とする**(この不変条件を破ると全体ゲートが赤化する)。
- **2.2 完了**: `src/lib/ai/env.ts` を `packages/schemas/src/env.ts` へ挙動等価で複製(NFR-3)。
  `emptyToUndefined` 正規化・`.default()` を維持(`diff -w` で一致確認)。旧 `src/lib/ai/env.ts` は
  `src/lib/ai/provider.ts`(`./env`)・`tests/provider.spec.ts` が現用のため**削除しない**(消費側の
  再配線=3.2 provider 移設 / 6 app 移設 まで temporary duplication で両緑)。既存 `tests/provider.spec.ts`
  の `parseAiEnv` 契約(defaults / 空文字正規化 / 不正値)が test-first 契約として緑を維持。
  新ファイルは未 import のためゲート typecheck 非被覆 → 分離 `tsc --ignoreConfig …`(node types)で
  単体コンパイル検証済み。schemas に test ファイル境界は無い(File Structure Plan 非掲載)ため新規テストは追加しない。
- **[FLAG] R1.8 × env.ts の既定モデル ID**: `packages/schemas/src/env.ts` は既定モデル ID
  (`"claude-opus-4-8"` / `"llama3.2"`)を保持する。これは 2.2 の Requirements=NFR-3 のみ(1.8 非含)・
  「移設(挙動等価)」指示・behavior preservation に忠実な結果。ただし R1.8 は
  `@vaz/config/model-allowlist.ts`(Task 3.3)を**唯一の合法直書き箇所**と規定。`@vaz/schemas` は依存グラフの
  leaf(`@vaz/config` を import 不可)のため env.ts 側で defaults を config へ委譲できない。
  **要反映**: `scripts/forbid-model-ids.sh`(Task 7.4)は env.ts の schema `.default()` を除外するか、
  3.2/3.3 で resolveModel が allowlist から default 供給する形へ寄せる(env.ts は Phase 1 で以後不変、
  Phase 2 の 8.5 で embedding provider 追加時に再編集機会あり)。7.5 全ゲート緑化前に要トリアージ。
- **2.3 完了**: `src/lib/ai/chat-schema.ts` を `packages/schemas/src/chat.ts` へ挙動等価で複製(NFR-6、
  `diff -w` 一致)。旧ファイルは `src/app/api/chat/route.ts`・`tests/chat-schema.spec.ts` が現用のため
  **非削除**(消費側再配線=6 app 移設 まで両緑)。既存 `tests/chat-schema.spec.ts`(6 ケース: 有効配列 /
  looseObject 透過 / 空配列拒否 / 不正 role / type 欠落 / messages キー欠落)が test-first 契約として緑を維持。
  model ID 非含のため R1.8 懸念なし。分離 `tsc`(node types 不要)で単体コンパイル検証済み。
- **2.4 完了**: `deps.ts` は 2.2/2.3 と異なり**既存元無しの新規契約**。関数(logger メソッド・`now`)を
  含むため Zod ではなく **pure TS 型**で定義(schemas は「Zod スキーマ + 推論/契約型」を持つ)。
  内容: `Logger`(debug/info/warn/error + `LogFields`、R4.7 PII 非記録は JSDoc 契約=INFO 既定で raw
  prompt/tool I/O 非記録、明文化は 16.3)/ `Clock = () => Date`(R1.4 注入時計、unit-testable)/
  `AuditEntry`(userId/jobId/tool/args/ts、userId・jobId は null 可)+ `AuditSink`(R5.5、20.1 で
  `AuditEntrySchema` 確定)/ `AgentDeps<DB = unknown>` { db, logger, now, audit? }(R1.3)。
  設計判断: (a) `db` は generic 既定 unknown — 具体 client(Drizzle)は leaf schemas から import 不可、
  かつ deps.ts は Phase 2 非編集のため generic で前方互換(RAG は `AgentDeps<PostgresJsDatabase>`)。
  (b) `audit?` optional=省略で no-op(Phase 1 許容)。(c) `runtimeContext`(userId/role)は Phase 5(18.2)
  スコープのため本タスクでは非定義。TDD: 型のみ=実行時ロジック無しのため ephemeral type-probe で
  RED(TS2307 `./deps` 無し)→GREEN(consumer 想定 usage が型検査 exit 0)→probe 削除で型契約の可用性を実証。

**Task 2（`@vaz/schemas` 契約パッケージ）完了**: 2.1–2.4 全緑。単一正本(NFR-6)の Phase 1 分
(env/chat/deps)を確立。旧 `src/lib/ai/{env,chat-schema}.ts` は app 移設(Task 6)まで temporary
duplication で保持。未 import の schemas src は consumers 配線(Task 3 以降)で transitive 被覆、最終は 7.5。

---

## 3. (P) `@vaz/config` env 駆動解決と可観測性初期化

`resolveModel` を移設し、合法モデル ID の唯一の集約点を作り、OTel/Langfuse を
fail-soft で初期化する。

_Boundary:_ `packages/config/package.json`, `packages/config/src/provider.ts`, `packages/config/src/model-allowlist.ts`, `packages/config/src/telemetry.ts`
_Depends:_ 2
_Requirements:_ 1.8, 4.1, 4.3, NFR-3, NFR-4, NFR-7

- [x] 3.1 `packages/config/package.json` を作成し `@vaz/config` として定義する。
  _Boundary:_ `packages/config/package.json`
  _Depends:_ 2.1
  _Requirements:_ 1.8
- [x] 3.2 `src/provider.ts` に `resolveModel(env?)` を移設し、`@vaz/schemas` の
  `parseAiEnv` 経由で env からモデル/プロバイダを解決する（直書きなし）。
  _Boundary:_ `packages/config/src/provider.ts`
  _Depends:_ 3.1, 2.2
  _Requirements:_ 1.8, NFR-3
- [x] 3.3 `src/model-allowlist.ts` を作成し、合法なモデル ID 既定値を唯一の
  合法直書き箇所として集約する。
  _Boundary:_ `packages/config/src/model-allowlist.ts`
  _Depends:_ 3.1
  _Requirements:_ 1.8
- [x] 3.4 `src/telemetry.ts` に `initTelemetry()`（`@ai-sdk/otel` `registerTelemetry`、
  Langfuse OTLP は env 有時のみ、未設定時は警告 1 回で起動継続）を実装する。
  _Boundary:_ `packages/config/src/telemetry.ts`
  _Depends:_ 3.1
  _Requirements:_ 4.1, 4.3, NFR-4, NFR-7

### Implementation Notes

- **3.1 完了**: `@vaz/config` を `@vaz/schemas` と同型の source-only(JIT)パッケージとして定義
  (`type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }` wildcard /
  `typecheck` echo marker)。wildcard export により後続 `provider`/`model-allowlist`/`telemetry`
  (3.2–3.4) および Phase 2 `embedding`(8.4) 追加時も本 package.json の再編集は不要。
  `pnpm install --frozen-lockfile` は "all 3 workspace projects / Already up to date"(lockfile
  churn ゼロ)、`mise run typecheck` 緑、`vitest` 17 passed(回帰なし)。
- **単一編集境界としての dependencies 前方宣言**: 3.2/3.3/3.4 の編集境界は `src/*.ts` のみで
  package.json を再編集できない。よって 2.1(zod 前方宣言)と同様、`@vaz/config` が R1.8
  (モデル解決)スコープで必要とする外部依存を 3.1 で先行宣言した — `@vaz/schemas`(`workspace:*`、
  provider が `parseAiEnv` を消費、3.2 が最初の consumer)+ `ai` / `@ai-sdk/anthropic` /
  `@ai-sdk/openai-compatible`(現行 `src/lib/ai/provider.ts` の resolveModel 実体、いずれも root
  package.json 既存＝lockfile 解決済み・install リスクなし)。
- **[FLAG] telemetry 依存の未宣言(3.4 で要トリアージ)**: `telemetry.ts`(3.4)が要する
  `@ai-sdk/otel`(`registerTelemetry`)/ Langfuse OTLP exporter は本 3.1 で**意図的に非宣言**。
  理由: (a) 3.1 の Requirements は 1.8 のみで telemetry(R4.1/4.3)は 3.4 のスコープ、(b) これらは
  root/lockfile 未導入の新規外部依存であり、宣言すると次回 install が `minimumReleaseAge: 1440`
  ・`allowBuilds`(default deny)の supply-chain ゲート判断を要する(=telemetry タスクの責務)。
  ただし package.json は単一編集境界のため、3.4 は telemetry 依存を config/package.json へ追加
  できない矛盾が生じる。**3.4 での解決策**: telemetry 依存を root package.json(移行期の dep home、
  hoisting で config から解決可)へ導入するか、3.4 で config/package.json を編集境界へ含める。
  supply-chain 決定(minimumReleaseAge / allowBuilds)は 3.4 実装時に明示監査する。
- **3.2 完了**: `src/lib/ai/provider.ts` の `resolveModel(env?)` を `packages/config/src/provider.ts`
  へ挙動等価で移設(2.2/2.3 と同一の migration パターン)。差分は import 元のみ
  (`./env` → `@vaz/schemas/env`) + doc コメント追記で、switch/return ロジックは byte-identical。
  R1.8/NFR-3「直書きなし」は provider に model ID を持たず parseAiEnv 経由で env 駆動解決する形で充足
  (provider の `name: "ollama"` は provider 名でありモデル ID ではない)。旧 `src/lib/ai/provider.ts` は
  `src/app/api/chat/route.ts`・`tests/provider.spec.ts` が現用のため**非削除**(消費側再配線=6 app 移設まで
  temporary duplication で両緑)。`tests/provider.spec.ts`(parseAiEnv defaults/空文字/不正値 + resolveModel
  の modelId/provider 契約)が test-first 契約として緑を維持。
- **allowlist 統合は 3.2 非スコープ**: 3.2 は 3.3 に依存せず、指示も「parseAiEnv 経由で解決」のみ。
  よって model-allowlist(3.3)との配線は行わず挙動等価に留めた。2.2 の [FLAG] R1.8(env.ts 既定モデル ID
  vs config allowlist)の整合は 3.3(allowlist 新設)/ 7.4(forbid-model-ids)で判断する。provider が
  parseAiEnv 経由で default を得る構造は維持したため、3.3 以降で default 供給元を allowlist へ寄せる
  余地は残る。
- **検証(no-test-boundary migration)**: `@vaz/config` に test ファイル境界は無い(File Structure Plan
  非掲載)ため新規テストは追加せず、ephemeral type-probe で RED(TS2307 `./provider` 無し)→GREEN
  (isolated tsc exit 0、`@vaz/schemas/env` subpath 解決)→probe 削除。gate typecheck は source-only の
  echo marker のため本 module 非被覆(最終被覆は consumers 配線 = 5.2/6.3、集約は 7.5)。
- **3.3 完了 / [解決] R1.8 FLAG**: `packages/config/src/model-allowlist.ts` を R1.8/ADR-5 の
  「合法直書きの唯一の集約点」として新設。`research.md` ADR-5「grep gate は `claude-`/`llama3` literal を
  `@vaz/config`/env の**外**で検出」「One allow-list location(`@vaz/config`) for legitimate default IDs」を
  根拠に、2.2/3.1/3.2 で持ち越した R1.8 FLAG(env.ts 既定モデル ID の重複)を**設計上解決**: env.ts(schemas
  leaf、config を import 不可)の `.default()` literal は grep gate の **env carve-out** で許容され、
  model-allowlist.ts は canonical allow-list。両者は同値(`claude-opus-4-8`/`llama3.2`)を維持し 7.4 が双方を除外。
- **設計**: `MODEL_ALLOWLIST`(provider→非空 tuple `readonly [string, ...string[]]`) + `DEFAULT_MODEL_ID`
  (各 allowlist の先頭要素を採用＝default は必ず allowlist メンバー)。provider union は `@vaz/schemas/env` の
  `AiEnv["AI_PROVIDER"]` を type import し `satisfies Record<AiProvider, …>` で**全 provider 網羅を強制**
  (enum 追加時に未更新なら型エラー＝R1.8 invariant)。literal は本ファイルに一度だけ出現(真の単一集約点)。
- **非スコープ**: 現行タスクグラフで model-allowlist を import する consumer は無い(3.2 provider は 3.3 非依存で
  parseAiEnv 経由・挙動等価、7.4 は grep で import せず)。よって「allow-list を宣言し legitimate literal の
  唯一の合法在処にする」ことが 3.3 の deliverable であり、predicate 等の runtime ロジックは付けない
  (config に test 境界無し / pure typed data として type-probe 検証)。将来 provider validation で
  参照する余地は残す。
- **検証**: ephemeral type-probe RED(TS2307 `./model-allowlist` 無し)→GREEN(probe/standalone tsc exit 0)。
  加えて**負例**で網羅 invariant を実証(`ollama` を一時削除 → `TS1360 does not satisfy Record<"anthropic"|"ollama",…>`)。
  env.ts 既定値との同値を grep で確認。
- **3.4 完了 / [解決] telemetry supply-chain FLAG(3.1)**: `initTelemetry(env?)` を実装。
  `registerTelemetry(new OpenTelemetry())`（`registerTelemetry` は `ai@7.0.14` 既存 export、
  `OpenTelemetry` は `@ai-sdk/otel`）で AI SDK↔OTel bridge を無条件登録（NFR-7: Phase 1 から OTel 有効）。
  Langfuse OTLP は `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` 有時のみ（R4.3、exporter 実体は host の
  `registerOTel` = 6.4）、未設定時は `console.warn` を **1 回**出して起動継続（NFR-4 fail-soft、never throw）。
  module-level `initialized` フラグで register/warn を各 1 回に冪等化。
- **[解決] 単一編集境界 × 新規依存の矛盾**: 3.1 [FLAG] で予告した通り、`@ai-sdk/otel` は 3.4 の宣言境界
  (`telemetry.ts`)外の `packages/config/package.json` に追加が必要。3.1 Note で事前承認済みの通り
  **config/package.json へ境界拡張**して `@ai-sdk/otel: "^1.0.14"` を宣言（root ではなく owner=config へ）。
  supply-chain 監査: `1.0.15` は 7.6h で `minimumReleaseAge:1440` により除外 → pnpm が **1.0.14**(41h, >24h)へ
  自動解決。install script 無し（allowBuilds 追記不要）。dep の `ai:7.0.14` は workspace 解決版と一致し
  **単一 ai copy に dedup**（`registerTelemetry` の runtime channel 二重化リスク無し）。`pnpm audit` = clean。
- **設計判断**: (a) Langfuse env は `@vaz/schemas` env schema へ追加せず telemetry.ts で防御的に直読み
  （env.ts は @vaz/schemas 境界・frozen、3.4 の Requirements に NFR-3 非含、観測性 optional 設定のため）。
  (b) logger（deps.ts, R4.7）ではなく `console.warn` を採用（initTelemetry は instrumentation 段の bootstrap で
  logger/deps 構築前に走るため）。(c) OTLP exporter 実体の配線は host（`registerOTel`, 6.4）へ委譲し、
  telemetry.ts は bridge 登録 + fail-soft guard に限定（境界最小・dep 最小）。
- **検証**: ephemeral vitest spec（`tests/__telemetry.probe.spec.ts`、実行後削除）で RED
  （`Failed to resolve import "../packages/config/src/telemetry"`）→ GREEN（2 tests: warn-once/no-throw/冪等 +
  Langfuse 分岐、mock 無しで real 契約を検証）。isolated tsc exit 0（`@ai-sdk/otel`+`ai` 解決）。

**Task 3（`@vaz/config`）完了**: 3.1–3.4 全緑。env 駆動 `resolveModel`（挙動等価移設）+ R1.8 allowlist
（唯一の合法直書き、ADR-5 で env carve-out と併存）+ fail-soft `initTelemetry`（`@ai-sdk/otel`, NFR-4/7）を確立。
Wave A は 3(P)∥4(P) のうち 3 完了 → 次は 4（`@vaz/tools`）。config src は未 import のため gate 非被覆、
最終被覆は consumers 配線（5.2/6.3/6.4）+ 7.5。

---

## 4. (P) `@vaz/tools` capability パッケージ

`tool({ description, inputSchema, execute })` を capability 単位で束ね、`execute`
が deps を closure から読む形へ demo ツールを移設する。

_Boundary:_ `packages/tools/package.json`, `packages/tools/src/time.ts`, `packages/tools/src/index.ts`
_Depends:_ 2
_Requirements:_ 1.4

- [x] 4.1 `packages/tools/package.json` を作成し `@vaz/tools` として定義する。
  _Boundary:_ `packages/tools/package.json`
  _Depends:_ 2.1
  _Requirements:_ 1.4
- [x] 4.2 `src/time.ts` に `createTimeCapability(deps)` を実装し、既存 `getCurrentTime`
  を deps closure 化する（`deps.now` を参照、unit-testable）。
  _Boundary:_ `packages/tools/src/time.ts`
  _Depends:_ 4.1, 2.4
  _Requirements:_ 1.4
- [x] 4.3 `src/index.ts` で capability を集約 export する。
  _Boundary:_ `packages/tools/src/index.ts`
  _Depends:_ 4.2
  _Requirements:_ 1.4

### Implementation Notes

- **4.1 完了**: `@vaz/tools` を 2.1/3.1 と同型の source-only(JIT)パッケージとして定義
  (`type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }` wildcard /
  `typecheck` echo marker)。wildcard export により後続 `time`/`index`(4.2–4.3) および Phase 3+ の
  `email`(12.3)/`allowlist`(19.3) 追加時も本 package.json の再編集は不要。
- **単一編集境界としての dependencies 前方宣言**: 4.2/4.3 の編集境界は `src/*.ts` のみで
  package.json を再編集できない。よって 2.1/3.1 と同様、`@vaz/tools` が R1.4(capability 移設)
  スコープで必要とする依存を 4.1 で先行宣言した — 現行 `src/app/api/chat/route.ts` の
  `getCurrentTime`(4.2 で `createTimeCapability(deps)` へ移設)が消費する `ai`(`tool()`)+
  `zod`(`inputSchema`)+ `@vaz/schemas`(`workspace:*`、4.2 が `deps.now`=`Clock` を `AgentDeps` から参照)。
  いずれも root/lockfile 既存の解決済みバージョン(`ai@^7.0.14` / `zod@^4.4.3` / workspace member)で
  **新規外部依存ゼロ** → `pnpm install` は `downloaded 0, added 0`(supply-chain 判断不要・install script
  無しで allowBuilds 追記不要)。
- **[解決] frozen mise.toml との typecheck 配線衝突(2.1 の不変条件を継承)**: 凍結境界の
  `mise run typecheck` は `pnpm -r run typecheck` を用いるため、メンバー ≥1 で該当 script 0 だと
  `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`(exit 1)。`@vaz/tools` も `typecheck` echo marker を必須で保持し
  (`pnpm -r` は scope 3 projects で全緑)、この不変条件を維持した。**後続 5.1(`@vaz/agents`)以降の
  source-only package.json も同様に `typecheck` script を必須とする**。
- **検証**: `pnpm install --frozen-lockfile`=Already up to date(churn ゼロ、初回 install で member 記録後)、
  `mise run typecheck` exit 0(schemas/config/tools 3 members + root tsc)、`vitest` 17 passed(回帰なし)、
  `biome check packages/tools/` clean(tabs/フォーマット準拠)。
- **4.2 完了**: `createTimeCapability(deps)` を実装(`packages/tools/src/time.ts`)。route.ts の inline
  `getCurrentTime` を **挙動等価**で移設し、唯一の差分は clock source(`new Date()` → `deps.now()`)。
  `AgentDeps`(2.4)を closure から受け、`Clock = () => Date` の注入で ambient global を排し unit-testable 化
  (R1.4)。戻り値は `{ getCurrentTime }`(plan の capability 形状)。旧 route の tool は 6.3 の app 移設
  (route を薄いアダプタへ縮退)まで temporary duplication で保持。
- **TDD(no-test-boundary → ephemeral probe)**: tools に test 境界は無い(File Structure Plan 非掲載、
  durable な tool 選択検証は 5.4 MockLanguageModelV4)。よって 3.4 と同じ ephemeral vitest probe
  (`tests/__time.probe.spec.ts`、root include 位置、実行後削除)で RED→GREEN。RED=`time.ts` 不在で
  import 解決失敗(vitest "1 failed / no tests")→ GREEN=3 tests passed(注入 clock の決定論性 /
  timeZone 既定 UTC / capability ごとの closure 独立性を mock なしの real 契約で検証)→ probe 削除。
- **検証(4.2)**: isolated tsc(`--ignoreConfig --strict --moduleResolution bundler`)exit 0
  (`@vaz/schemas/deps`+`ai`+`zod` 解決、`packages/tools/node_modules/@vaz/schemas` symlink 経由)、
  `mise run test:run` 17 passed(probe 削除後・回帰なし)、`mise run typecheck` exit 0
  (`packages/tools typecheck: Done`)、`mise run lint` exit 0(32 files、biome 100-char 折返しは lint:fix 適用)。
- **4.3 完了**: `packages/tools/src/index.ts`（capability 集約 barrel）を新設し `createTimeCapability` を
  re-export（`export { … } from "./time"`、value re-export＝`verbatimModuleSyntax` 準拠）。consumers
  （5.2 `createChatAgent`）は `@vaz/tools/index`（`"./*": "./src/*.ts"` map）から capability を取得する。
  Phase 3+ の `email`/`allowlist` capability もここへ追加される想定。
- **検証(4.3)**: ephemeral probe（`tests/__tools-index.probe.spec.ts`）で RED（index.ts 不在→import 解決失敗、
  `1 failed / no tests`）→ GREEN（`1 passed`＝re-export が解決し `createTimeCapability` が function、
  `getCurrentTime` を生成）→ probe 削除。isolated tsc exit 0（`./time` 経由で `@vaz/schemas/deps`+`ai`+`zod` 解決）、
  `mise run test:run` 17 passed（回帰なし）、`mise run typecheck` exit 0（`packages/tools typecheck: Done`）、
  `mise run lint` exit 0（33 files）。

**Task 4（`@vaz/tools` capability パッケージ）完了**: 4.1–4.3 全緑。source-only(JIT)パッケージ + deps closure
化した `createTimeCapability`（`new Date()` → `deps.now()`、unit-testable, R1.4）+ 集約 barrel を確立。
Wave A の `3 (P) ∥ 4 (P)` は両完了 → 次は 5（`@vaz/agents`）。旧 route の inline tool は 6.3 の app 移設まで
temporary duplication で保持。tools src（time/index）は未 import のため gate は source-only echo marker で
非被覆、最終被覆は consumers 配線（5.2 `createChatAgent`）+ 7.5。

---

## 5. `@vaz/agents` エージェントコアと Mock 単体テスト

`createChatAgent(deps)` を提供し、現行 `streamText` を挙動等価で封じ込めたうえで
`MockLanguageModelV4` によりネットワークなしの単体テストを成立させる。

_Boundary:_ `packages/agents/package.json`, `packages/agents/src/chat-agent.ts`, `packages/agents/src/index.ts`, `packages/agents/tests/chat-agent.spec.ts`
_Depends:_ 3, 4
_Requirements:_ 1.3, 1.6, 1.7

- [x] 5.1 `packages/agents/package.json` を作成し `@vaz/agents`（`@vaz/schemas`/`@vaz/config`/`@vaz/tools` 依存）として定義する。
  _Boundary:_ `packages/agents/package.json`
  _Depends:_ 3.1, 4.1
  _Requirements:_ 1.3
- [x] 5.2 `src/chat-agent.ts` に `createChatAgent(deps)` を実装し、`resolveModel()` +
  tools + `stopWhen: isStepCount(n)` を内包する（まず現行挙動と等価に封じ込め、回帰緑後に `ToolLoopAgent` 化）。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 5.1, 2.4, 3.2, 4.3
  _Requirements:_ 1.3, 1.7
- [x] 5.3 `src/index.ts` でエージェント公開 API（`createChatAgent`/`AgentDeps` 再 export）を定義する。
  _Boundary:_ `packages/agents/src/index.ts`
  _Depends:_ 5.2
  _Requirements:_ 1.3
- [x] 5.4 `tests/chat-agent.spec.ts` を `MockLanguageModelV4`（`ai/test`）+ mock deps で
  記述し、LLM API 呼び出し・ネットワークなしでツール選択/ループ制御を検証する
  （Red-Green: 5.2 実装前に失敗テストとして先行作成し、失敗を確認してから 5.2 を実装する）。
  _Boundary:_ `packages/agents/tests/chat-agent.spec.ts`
  _Depends:_ 5.1
  _Requirements:_ 1.6

### Implementation Notes

- **5.1 完了**: `@vaz/agents` を 2.1/3.1/4.1 と同型の source-only(JIT)パッケージとして定義
  (`type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }` wildcard /
  `typecheck` echo marker)。wildcard export により後続 `chat-agent`/`index`(5.2–5.3) および
  Phase 3+ の `supervisor`(12.1)/`approval-policy`(12.2)/`prompt`(19.1)/`audit-hook`(20.2) 追加時も
  本 package.json の再編集は不要。
- **単一編集境界としての dependencies 前方宣言**: 5.2(`src/chat-agent.ts`)・5.3(`src/index.ts`)・
  5.4(`tests/chat-agent.spec.ts`) はいずれも package.json と別の単一編集境界で再編集できない。
  よって 2.1/3.1/4.1 と同様、`@vaz/agents` が R1.3/1.7(agent コア)スコープで必要とする依存を 5.1 で
  先行宣言した — `@vaz/schemas`(`workspace:*`、`AgentDeps` 契約=2.4)+ `@vaz/config`(`workspace:*`、
  `resolveModel`=3.2)+ `@vaz/tools`(`workspace:*`、`createTimeCapability`=4.3)+ `ai`(`^7.0.14`、
  5.2 の `streamText`/`isStepCount`、および 5.4 の `ai/test` `MockLanguageModelV4`)。`zod` は
  agents が直接 schema を著述せず(tools が `inputSchema` を所有)非宣言 — `@vaz/config` と同一の方針
  (direct dep のみ宣言)。全て root/lockfile 既存の解決済みバージョン(workspace member + `ai@^7.0.14`)で
  **新規外部依存ゼロ** → `pnpm install` は `downloaded 0, added 0`(supply-chain 判断不要・install script
  無しで allowBuilds 追記不要)、`--frozen-lockfile` clean。
- **[解決] frozen mise.toml との typecheck 配線衝突(2.1 の不変条件を継承)**: 凍結境界の
  `mise run typecheck` は `pnpm -r run typecheck` を用いるため、メンバー ≥1 で該当 script 0 だと
  `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`(exit 1)。`@vaz/agents` も `typecheck` echo marker を必須で保持し、
  この不変条件を維持した(`pnpm -r` は scope 4 of 5 projects で全緑)。agents は test 境界を持つが
  (5.4 `tests/chat-agent.spec.ts`)、per-package tsconfig は File Structure Plan 非掲載のため未作成 —
  型検査は consumers(apps/web=6.3)+ root solution で transitive、tests は Vitest projects(7.1)で被覆。
- **検証**: `pnpm install`=`downloaded 0, added 0`(5 workspace projects、member 記録)、
  `pnpm install --frozen-lockfile`=Already up to date(churn ゼロ)、`mise run typecheck` exit 0
  (schemas/config/tools/agents 4 members + root tsc、`packages/agents typecheck: Done`)、
  `mise run test:run` 17 passed(回帰なし)、`mise run lint` 34 files clean(biome tabs/フォーマット準拠)。
- **5.2 完了**: `createChatAgent(deps, options?)` を実装(`packages/agents/src/chat-agent.ts`)。現行
  route の `streamText({ model: resolveModel(), messages: await convertToModelMessages(...), tools: { getCurrentTime }, stopWhen: isStepCount(5) })` を **挙動等価**で封じ込め(R1.3/1.7)。差分は
  (a) model が `@vaz/config/provider#resolveModel`、(b) tools が `@vaz/tools/index#createTimeCapability(deps)`
  の `{ getCurrentTime }`(inline 定義を廃し capability closure 参照)、(c) UI stream ブリッジ
  (`toUIMessageStream`→`createUIMessageStreamResponse`)は route 側に残す設計(plan L113-115、6.3 で配線)。
  `stream({ messages })` は `convertToModelMessages`(`Promise<ModelMessage[]>`)を await するため async、
  戻り値は `StreamTextResult`(route は `result.stream` を消費)。
- **[設計判断] model injection seam**: plan の公開 IF は `createChatAgent(deps)` だが、spec 自身の
  テスト戦略(R1.6: `MockLanguageModelV4` でネットワークなし tool 選択/ループ検証)が model 注入点を要求する。
  optional 第2引数 `options.model`(既定 `?? resolveModel()`)を追加し **call site `createChatAgent(deps)` を不変**に保った。
  既定経路は `resolveModel()` を **stream() 毎に遅延解決** → per-request env 解決の不変条件を保持(R1.8/NFR-3、
  provider switch は再起動不要)。model ID の直書きは無し(config へ委譲)。
- **[申し送り] `generate` 未実装**: plan は `stream`/`generate` を掲げるが、現行 route は stream のみ使用。
  「挙動等価封じ込め」に忠実に `stream` のみ実装(generate は保存すべき現行挙動が無い)。
  `ToolLoopAgent` 化(回帰緑後)or Phase 3 で generate を追加する。
- **TDD(no-test-boundary → ephemeral probe)**: 5.2 の編集境界は `chat-agent.ts` のみ(durable test は
  5.4 = 別境界 `tests/chat-agent.spec.ts`)。よって 3.4/4.2/4.3 と同じ ephemeral vitest probe
  (`tests/__chat-agent.probe.spec.ts`、実行後削除)で RED→GREEN。RED=`chat-agent` 不在で import 解決失敗
  (`Test Files 1 failed / no tests`)→ GREEN(`1 passed`＝`createChatAgent(deps,{model:MockLanguageModelV4})`
  が `stream` を持ち、`stream({messages})` が `convertToModelMessages` を経て `.stream`/`.textStream` を持つ
  `StreamTextResult` を network なしで返す)→ probe 削除。**5.4 がこの検証を恒久化**。
- **検証(5.2)**: isolated tsc(`--ignoreConfig --strict --moduleResolution bundler`)exit 0
  (`@vaz/config/provider`+`@vaz/schemas/deps`+`@vaz/tools/index`+`ai` 解決)、`mise run typecheck` exit 0、
  `mise run test:run` 17 passed(probe 削除後・回帰なし)、`mise run lint` 35 files clean(chat-agent.ts 追加で 34→35)。
  gate typecheck は source-only echo marker のため本 module 非被覆 → 最終被覆は consumer 配線(6.3 route)+ 7.5。
- **5.3 完了**: `packages/agents/src/index.ts`（公開 API barrel）を新設。value re-export
  `export { createChatAgent } from "./chat-agent"`（`verbatimModuleSyntax` 準拠）+ type re-export
  `export type { ChatAgent, ChatAgentStreamOptions, CreateChatAgentOptions } from "./chat-agent"` +
  `export type { AgentDeps } from "@vaz/schemas/deps"`（単一正本 @vaz/schemas を単一 entry で再 export、
  plan L109-110 公開 IF）。consumers（6.3 route / 5.4 tests）は `@vaz/agents/index`（`"./*": "./src/*.ts"` map）から取得。
- **[解決] biome organizeImports の export 順序衝突**: 初版は doc コメントを export 間に挟んだため
  `assist/source/organizeImports`（FIXABLE）が `Sort these exports` で赤化。biome の canonical order は
  外部（`@vaz/schemas/deps`）→ 相対（`./chat-agent`）、同一 module 内は `export type` → `export`（value）。
  interleaved コメントを廃し単一 top block へ集約 + canonical 順で再記述して解決（blind retry ではなく
  root cause=決定論的 formatter rule を特定して対処）。
- **TDD(no-test-boundary → ephemeral probe)**: 5.3 境界は `index.ts` のみ（durable test は 5.4）。4.3 と同じ
  ephemeral probe（`tests/__agents-index.probe.spec.ts`、実行後削除）で RED（index.ts 不在→import 解決失敗、
  `Test Files 1 failed / no tests`）→ GREEN（`1 passed`＝barrel が `createChatAgent` を re-export し
  `createChatAgent(deps)` が `stream` を持つ agent を construction＝network なしで生成）→ probe 削除。
- **検証(5.3)**: isolated tsc（`--ignoreConfig …`）exit 0（value+type re-export が `./chat-agent` 連鎖 +
  `@vaz/schemas/deps` を解決）、`mise run typecheck` exit 0、`mise run test:run` 17 passed（回帰なし）、
  `mise run lint` 36 files clean（index.ts 追加で 35→36）。gate typecheck は echo marker のため非被覆 →
  最終被覆は consumer 配線（6.3 route）+ 7.5。
- **5.4 完了**: `packages/agents/tests/chat-agent.spec.ts`（durable 単体テスト、R1.6）を新設。
  `MockLanguageModelV4`(`ai/test`)を `options.model` seam(5.2)へ注入し、**network / 実 LLM 呼び出しなし**で
  検証。2 ケース: (a) 単一ターン text（tool 非選択、`doStreamCalls` 1）、(b) `getCurrentTime` 選択→ループ
  継続→最終応答（tool selection + loop control）。mock `AgentDeps`(no-op logger / 固定 Clock / db=null)。
- **設計(mock 形状 = ai@7.0.14 実地確認)**: `MockLanguageModelV4` の `doStream: [r1, r2]` 配列は
  **per-call 消費**(`node_modules/ai/dist/test/index.js:152` `doStream[doStreamCalls.length-1]`)。V4 stream
  chunk 形状は `@ai-sdk/provider@4.0.2` の `LanguageModelV4StreamPart` を参照: `tool-call`
  = `{type,toolCallId,toolName,input:<stringified JSON>}`、`finish`
  = `{type,finishReason:{unified,raw},usage:{inputTokens{total,noCache,cacheRead,cacheWrite},outputTokens{total,text,reasoning}}}`。
  chunk リテラルの型 widening を避けるため mock を **inline 構築**(constructor の contextual type で narrowing)。
- **loop control の検証点**: turn1 が `finishReason.unified:"tool-calls"` + `tool-call` chunk → SDK が登録
  ツール `getCurrentTime` を **client 実行**(deps closure、R1.4)→ 結果を戻し turn2 呼び出し(text, `stop`)。
  `model.doStreamCalls.length===2`(ループ 2 step 継続)+ turn2 で自然停止(< `isStepCount(5)`)を assert。
  `result.toolCalls`(parsed input)/`result.toolResults`(`output` に注入 Clock 由来の "2026" を含む)で tool selection を assert。
- **[配線注意 → 7.1 へ委譲]**: 本 spec は `packages/agents/tests/**` に在り、root vitest `include` は
  `tests/**` のみ(`vitest.config.ts:15`)のため `mise run test:run`(root)には**未含**。恒久配線(Vitest projects
  node env)は 7.1。5.4 の VERIFY は **ephemeral config**(`vitest.agents.tmp.config.ts`、node env/globals、実行後削除)で実施。
- **TDD(RED-Green + 非空虚性)**: 本モジュールの test-first RED は 5.2 の ephemeral probe(module 不在→import 失敗)で
  既達。durable spec の**非空虚性**を mutation で実証: loop-control 期待値を 2→1 に一時改変 → RED
  (`expected [ {…},{…} ] to have a length of 1 but got 2`)→ 復帰 → GREEN。
- **検証(5.4)**: ephemeral config vitest `Test Files 1 passed / Tests 2 passed`、isolated tsc
  (`--types node,vitest/globals`)exit 0(型健全)、`mise run typecheck` exit 0、`mise run lint` 37 files clean
  (spec 追加で 36→37)、`mise run test:run`(root)17 passed(回帰なし、agents spec は root include 外＝設計通り)。

**Task 5（`@vaz/agents` エージェントコア）完了**: 5.1–5.4 全緑。`createChatAgent(deps, options?)`（現行 route の
`streamText`+tools+`isStepCount(5)` を挙動等価封じ込め、R1.3/1.7）+ 公開 API barrel + `MockLanguageModelV4`
による network-free 単体テスト（tool 選択/ループ制御、R1.6）を確立。model 注入 seam により resolveModel 既定
（per-request env 解決、R1.8/NFR-3）とテスト時 mock 注入を両立。Wave A `1→2→{3∥4}→5` の 5 完了 → 次は
**Task 6（`apps/web` 移設 + route 薄アダプタ化 + OTel）**。agents src/tests の gate 被覆は 6.3 route 配線 + 7.1
Vitest projects + 7.5 で確立（現状 source-only echo marker + ephemeral 検証）。旧 `src/lib/ai/*` と inline route
tool は 6 の app 移設まで temporary duplication で保持。

---

## 6. `apps/web` への移設と薄いアダプタ化・OTel 起動

既存 Next.js アプリを `apps/web` へ移設し、`route.ts` を `@vaz/agents` への薄い
HTTP⇔Agent アダプタへ縮退、`instrumentation.ts` で OTel を Phase 1 から有効化する。

_Boundary:_ `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/features/chat/**`, `apps/web/src/assets/styles/global.scss`, `apps/web/src/app/api/chat/route.ts`, `apps/web/instrumentation.ts`
_Depends:_ 5
_Requirements:_ 1.5, 1.7, 4.1, NFR-7

- [x] 6.1 `apps/web/package.json`（`@vaz/*` 依存）と `apps/web/tsconfig.json`
  （base 継承 + `@ → src` alias）を作成する。
  _Boundary:_ `apps/web/package.json`, `apps/web/tsconfig.json`
  _Depends:_ 5.3
  _Requirements:_ 1.5
- [x] 6.2 `next.config.ts` / `layout.tsx` / `page.tsx` / `features/chat/**` /
  `global.scss` を `apps/web` へ移設する（`page.tsx` は Server Component 維持、React Compiler は web のみ、挙動等価）。
  _Boundary:_ `apps/web/next.config.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/features/chat/**`, `apps/web/src/assets/styles/global.scss`
  _Depends:_ 6.1
  _Requirements:_ 1.7
- [x] 6.3 `src/app/api/chat/route.ts` を薄い HTTP⇔Agent アダプタへ縮退する
  （Zod 検証 → `createChatAgent(deps).stream()` → `toUIMessageStream` → `createUIMessageStreamResponse`、オーケストレーションは route に置かない）。
  _Boundary:_ `apps/web/src/app/api/chat/route.ts`
  _Depends:_ 6.1, 5.3
  _Requirements:_ 1.5, 1.7
- [x] 6.4 `apps/web/instrumentation.ts` を作成し `registerOTel` + `initTelemetry()` を
  呼び、全 agent 呼び出しに OTel span を有効化する。
  _Boundary:_ `apps/web/instrumentation.ts`
  _Depends:_ 6.1, 3.4
  _Requirements:_ 4.1, NFR-7

### Implementation Notes

- **6.4 完了**: `apps/web/instrumentation.ts`（Next の instrumentation hook、起動時 1 回）を新設。`register()` が
  `registerOTel({ serviceName: "vaz-web" })`（`@vercel/otel`、6.1 で宣言済み ―― OTel SDK + OTLP trace exporter を host に
  構成、`OTEL_EXPORTER_OTLP_*` env 有時に Langfuse へ送出）→ `initTelemetry()`（`@vaz/config/telemetry`、AI SDK↔OTel bridge を
  登録）の順で呼ぶ。順序は「provider 確立（registerOTel）→ bridge 接続（initTelemetry）」が必須（do.md 3.4 の申し送りに一致）。
  全 `streamText`/agent 呼出しに span 有効化（R4.1/NFR-7）。両者 fail-soft（telemetry env 不在は警告 1 回で起動継続、never throw ―― NFR-4）。
- **[registerOTel API 実地確認]**: `ai@7`/`@vercel/otel@2.1.3` 同梱型 `registerOTel(optionsOrServiceName?: Configuration | string): void`
  ―― パッケージ docstring の canonical 用法（`register(){ registerOTel({ serviceName }) }`）に準拠（Constitution P3）。
- **[gate include 外 → isolated 検証]**: `instrumentation.ts` は apps/web root 直下で、6.1 の `tsconfig.json` include（`src` のみ、
  6.4 境界外で改変不可）に含まれないため gate `tsc` 非被覆。よって (a) isolated `tsc --ignoreConfig --strict --moduleResolution
  bundler` **exit 0**、(b) `next build` の型検査フェーズ通過（`✓ Compiled successfully`、失敗は既存 `/_global-error` prerender
  FLAG のみ ―― instrumentation 起因エラーなし）の 2 系統で型健全性を実証（3.4 の bootstrap 検証パターンを踏襲）。
- **検証**: isolated tsc exit 0、`next build` `✓ Compiled successfully`（FLAG 以外なし）、`mise run typecheck` exit 0、
  `mise run test:run` 17 passed（回帰なし）、`mise run lint` `Checked 45 files … No fixes applied.`（44→45、instrumentation.ts 追加）、
  `mise run audit` clean、`--frozen-lockfile` Already up to date。

**Task 6（`apps/web` 移設 + 薄アダプタ + OTel）完了**: 6.1–6.4 全緑。`@vaz/web` member 実体化（deps 前方宣言 + guarded typecheck）
→ UI/config を byte-identical 複製（temporary duplication）→ route を薄い HTTP⇔Agent アダプタ化（`@vaz/*` 全鎖の統合 typecheck 初点火）
→ instrumentation.ts で OTel を Phase 1 起動。Wave A `1→2→{3∥4}→5→6` の 6 完了 → 次は **Task 7（品質ゲート配線 + Phase 1 回帰検証）**。
**7 への申し送り（重要）**: 旧 root `src/**`（`app/{layout,page}`・`features/chat`・`assets/styles`・`app/api/chat/route.ts`・
`lib/ai/{env,chat-schema,provider}`）と `tests/{Chat,chat-schema,provider}.spec.ts` は temporary duplication で保持中。7.1 で Vitest
projects（web=jsdom / node packages）へ収斂させ、収斂後に root `./src` を撤去（mise typecheck の root tsc skip が発火）。E2E は 7.2 で
`apps/web/tests/e2e` へ移設。既存 build FLAG（`/_global-error`・`/_not-found` prerender の `useContext` null、React19.2×Next16）は
7.5 全ゲート緑化前に要トリアージ。

- **6.3 完了**: `apps/web/src/app/api/chat/route.ts` を薄い HTTP⇔Agent アダプタとして新設。責務は HTTP のみ
  ―― `chatRequestSchema`（`@vaz/schemas/chat`）で body 検証 → `AgentDeps` 構築 → `await createChatAgent(deps).stream({ messages })`
  （`@vaz/agents/index`）→ `toUIMessageStream({ stream: result.stream })` → `createUIMessageStreamResponse`。
  オーケストレーション（model 解決 / tools / stop 条件）は route に置かず `@vaz/agents` 内（R1.5）。既存の 400 応答規約
  （不正 JSON / Zod 失敗、Constitution P1）と UI stream 形状（`useChat` 互換, R1.7）を byte-level で保持。
- **[統合 typecheck の初点火]**: 本 route が `@vaz/*` チェーン全体（`@vaz/agents/index` → `chat-agent.ts` →
  `@vaz/config/provider` + `@vaz/tools/index` + `@vaz/schemas/{chat,deps}`）の**最初の実 consumer**。apps/web guarded `tsc`
  がこの wiring を transitive 型検査し **exit 0** ―― 5.2 の「挙動等価封じ込め」が route 呼出し形状（`stream({messages})` →
  `result.stream`）と型整合することを実証。build（`next build`）でも route は `.next/types/validator.ts` へ型検証付きで
  コンパイルされ、失敗は既存 `/_global-error` prerender FLAG のみ（route 起因のエラーなし）。
- **[deps 構築（route の責務）]**: `db: null`（Phase 1 stateless）/ `now: () => new Date()`（実時計、旧 inline tool の
  `new Date()` と等価）/ `logger`: console-backed sink（message + 明示 fields のみ記録、raw prompt/tool I/O は非転送＝R4.7
  privacy 契約準拠）。audit は省略＝no-op（Phase 1 許容, 2.4）。DB/audit sink 実装は後続 Phase。
- **[境界厳守 → temporary duplication 継続]**: 6.3 境界は `apps/web/.../route.ts` のみ。旧 root `src/app/api/chat/route.ts`
  + `src/lib/ai/{env,chat-schema,provider}.ts` は `tests/{chat-schema,provider}.spec.ts`（境界外, root vitest）が現用のため
  **非削除**（両緑）。root の重複撤去は unit test を web project へ収斂させる 7.1 で実施（6.2 の UI 複製と同じ収斂点）。
- **[format]**: 初版 logger の三項演算行が 100-char 超 → biome formatter が複数行へ折返し（`mise run lint:fix`、
  決定論的整形、logic 不変）。root cause=行長で blind retry ではない。
- **検証**: `mise run typecheck` exit 0（`apps/web typecheck: Done` 実 tsc で route→`@vaz/*` 全鎖を検査 + root `./src` tsc 緑）、
  `mise run test:run` 17 passed（回帰なし）、`mise run lint` `Checked 44 files … No fixes applied.`（format 適用後）、
  `mise run audit` clean、`--frozen-lockfile` Already up to date。build は既存 `/_global-error` prerender FLAG のみ（非回帰、7.5 トリアージ）。

- **6.2 完了**: UI/設定ファイル（`next.config.ts` / `src/app/{layout,page}.tsx` / `src/features/chat/**` /
  `src/assets/styles/global.scss`）を `apps/web` へ **byte-identical**（`cp` + `diff -q` で 6/6 一致）で配置。
  `page.tsx` は Server Component 維持（`"use client"` なし）、React Compiler は web のみ（`apps/web/next.config.ts`
  の `reactCompiler:true`、packages 非適用）、挙動等価。
- **[設計判断] move ではなく temporary duplication（2.2/2.3/3.2/4.2 の discipline を継承）**: plan は "Modify(move)" を
  掲げるが、root 原本を削除すると **6.2 境界外**のファイルが即座に回帰する: `tests/Chat.spec.tsx`（`@/features/chat/Chat`
  を import、root vitest `include: tests/**` + alias `@→./src`）、および root `tsc`（`./src` を include）。`tests/**`・
  `vitest.config.ts` の web project 化は 7.1、E2E 移設は 7.2、route+`lib/ai` retire は 6.3 で、いずれも 6.2 境界外。
  よって「no regression（17 tests 緑）」と「境界厳守」を両立する唯一解として **root 原本を保持したまま apps/web へ複製**。
  root `./src` の完全撤去は後続（6.3 で route/`lib/ai`、7.1 で unit test の web project 移設）完了後に可能となる。
- **[両状態緑] mise typecheck の二重被覆**: root `./src` が残存するため mise typecheck は現状 (a) `pnpm -r run typecheck`
  → apps/web の guarded `tsc`（`[ -d src ]` true で実行、`@vaz/*` JIT source を transitive 型検査）と (b) root `./src`
  tsc の**双方**が走り、両方緑。Task 1.3 が想定した「root tsc skip」は root `./src` 撤去後（6.3/7.1 完了後）に発火する。
- **[生成物] apps/web の Next 型アーティファクト**: apps/web guarded `tsc` は `.scss` side-effect import
  （`noUncheckedSideEffectImports`）と next 型解決のため `next-env.d.ts` + `.next/types/routes.d.ts` を要する。
  両者は gitignore 対象（`.next` / `next-env.d.ts`、repo 全体に適用）で `git status` を汚さず、`pnpm --filter @vaz/web exec
  next build` により**生成**した（build 自体は prerender 段の既存 FLAG で exit 1 だが、型生成は prerender 前に完了＝
  root と同様に artifacts 残存）。
- **[FLAG] apps/web build（既存 FLAG の再確認）**: `next build`（apps/web）は `/_global-error`・`/_not-found` の
  prerender で `TypeError: Cannot read properties of null (reading 'useContext')` により exit 1。これは HEAD の
  `/_not-found` prerender FLAG（1.2 記録）と同一クラス（React 19.2 × Next 16 の error-page prerender、6.2 は byte-identical
  複製ゆえ回帰ではない）。7.5 の全ゲート緑化前に要トリアージ。
- **検証**: `mise run typecheck` exit 0（`apps/web typecheck: Done` 実 tsc + root `./src` tsc 緑 + packages echo）、
  `mise run test:run` 17 passed（回帰なし、root 複製保持により Chat.spec 緑）、`mise run lint` `Checked 43 files … No fixes
  applied.`（39→43、`.ts/.tsx` 4 追加、scss は biome 非対象）、`mise run audit` clean、`--frozen-lockfile` Already up to
  date（複製は dep 不変＝churn ゼロ）。
- **6.3 申し送り**: route を薄アダプタ化して `apps/web/src/app/api/chat/route.ts` を作成し、root `src/app/api/chat/route.ts`
  + `src/lib/ai/{env,chat-schema,provider}.ts` を撤去。route 撤去後は root `tests/{chat-schema,provider}.spec.ts` の
  被写体が消えるため、これらの test の再配線（apps/web project or 撤去）を 7.1 と整合させる。root UI 複製
  （layout/page/features/global.scss）は `tests/Chat.spec.tsx` が web project へ移る 7.1 まで保持。

- **6.1 完了**: `apps/web`（`@vaz/web`）を workspace member として実体化。`package.json`（deps 宣言）+
  `tsconfig.json`（`../../packages/config/tsconfig.base.json` 継承 + Next/React overlay + `@ → src` alias）を作成。
  install=`+14`（`@vercel/otel@2.1.3` + 推移的 `@opentelemetry/*`、"Ignored build scripts" 警告なし＝allowBuilds 追記不要）、
  `--frozen-lockfile`=Already up to date。app 本体（`src/**`・`next.config.ts` 等）の移設は 6.2、旧 root `./src` は
  temporary duplication で保持。
- **単一編集境界としての dependencies 前方宣言（2.1/3.1/4.1/5.1 の discipline を継承）**: `apps/web/package.json` は
  Phase 1 で 6.1 が唯一の編集境界（6.2=`next.config`/`layout`/`page`/`features`/`scss`、6.3=`route.ts`、6.4=`instrumentation.ts`
  はいずれも別ファイル境界で package.json を再編集できない）。よって 6.2–6.4 で apps/web が消費する全 direct dep を 6.1 で
  先行宣言した — 移設ファイル/route/instrumentation が import する `@ai-sdk/react`・`@carbon/react`・`@carbon/styles`・
  `ai`・`next`・`react`・`react-dom`（既存 root/lockfile 解決済み、新規外部ゼロ）+ workspace `@vaz/agents`（route:
  `createChatAgent`）・`@vaz/schemas`（route: `chatRequestSchema`）・`@vaz/config`（instrumentation: `initTelemetry`）+
  **`@vercel/otel`**（6.4: `registerOTel`、do.md「6.4 への申し送り＝要 apps/web 依存追加」に対応する新規外部依存）。
  `@vaz/tools`・`zod`・`@ai-sdk/anthropic`・`@ai-sdk/openai-compatible` は web が直接 import せず（transitive）**非宣言**
  （direct-deps-only、5.1 の方針を踏襲）。
- **[解決] @vercel/otel の supply-chain 監査**: `latest`=`2.1.3`（2026-06-11 公開、>24h）→ `minimumReleaseAge:1440` に抵触せず
  解決。install script 無し（`+14` で "Ignored build scripts" 出力なし）→ `allowBuilds`（pnpm-workspace.yaml、6.1 境界外）追記不要。
  `pnpm audit`=No known vulnerabilities（新規 OTel deps clean）。
- **devDependencies 非宣言（他 4 パッケージと同型）**: tooling（typescript/biome/vitest/sass/babel-plugin-react-compiler/
  @types/*）は root に集約し、pnpm の ancestor `node_modules/.bin` PATH + Node 親ディレクトリ解決で apps/web から到達。
- **移行期の両状態緑（Task 1 の「前方互換」idiom を踏襲）**: apps/web の `typecheck` script は `if [ -d src ]; then tsc --noEmit;
  else echo … skip; fi` ガードで、6.1（src 未移設＝skip・緑）と 6.2 移設後（src 在中＝`tsc` 実 typecheck、`@vaz/*` JIT source を
  transitive 型検査）の双方で緑。凍結 mise（1.3）の `pnpm -r run typecheck`（member ≥1・該当 script 必須の不変条件）も満たす。
- **検証（no source-boundary scaffolding）**: 2.1/3.1/4.1/5.1 と同様 test 境界を持たず（File Structure Plan 非掲載）、gate で検証。
  `mise run typecheck` exit 0（`apps/web typecheck: … skip` + root `./src` tsc 緑）、`mise run test:run` 17 passed（回帰なし）、
  `mise run lint` `Checked 39 files … No fixes applied.`（37→39、biome tabs/format 準拠）、`mise run audit` clean、
  `--frozen-lockfile` Already up to date。build は既存 [FLAG]（`/_not-found` prerender、HEAD 由来）につき非対象・7.5 トリアージ。
- **6.2–6.4 への申し送り**: (6.2) `src/**`・`next.config.ts`・`next-env.d.ts` を `apps/web` へ移設、React Compiler は web のみ
  （`next.config.ts` の `reactCompiler:true`）。移設完了で旧 root `./src` 消滅 → mise typecheck の root tsc が `[ -d src ]` false で
  skip、apps/web の guarded typecheck が実 tsc へ切替。(6.3) route を薄アダプタ化（`chatRequestSchema` 検証 →
  `createChatAgent(deps).stream({messages})` → `toUIMessageStream` → `createUIMessageStreamResponse`）。(6.4)
  `instrumentation.ts` で `registerOTel`（`@vercel/otel`、宣言済み）+ `initTelemetry()`。旧 `src/lib/ai/*`・route inline tool は
  6 完了で重複解消。

---

## 7. ワークスペース品質ゲート配線と Phase 1 回帰検証

Vitest projects / Playwright / git hooks / モデル ID 直書き検出をワークスペース対応へ
改修し、全ゲート緑かつ Phase 1 スコープ限定（RAG/WF 非混入）を検証する。

_Boundary:_ `vitest.config.ts`, `apps/web/vitest.config.ts`, `playwright.config.ts`, `.githooks/pre-commit`, `.githooks/pre-push`, `apps/web/tests/e2e/**`, `scripts/forbid-model-ids.sh`
_Depends:_ 6
_Requirements:_ 1.7, 1.8, 1.9, 1.10, NFR-1, NFR-5

- [x] 7.1 (P) `vitest.config.ts` を Vitest projects（web=jsdom / node パッケージ=node）へ
  変更し、`apps/web/vitest.config.ts` を追加する。
  _Boundary:_ `vitest.config.ts`, `apps/web/vitest.config.ts`
  _Depends:_ 6.2
  _Requirements:_ 1.9, NFR-1
- [x] 7.2 (P) `playwright.config.ts` の webServer を `--filter @vaz/web` へ切替え、既存 E2E を
  `apps/web/tests/e2e/**` へ移設する（回帰なし）。
  _Boundary:_ `playwright.config.ts`, `apps/web/tests/e2e/**`
  _Depends:_ 6.2
  _Requirements:_ 1.7, 1.9
- [x] 7.3 (P) `.githooks/pre-commit`・`.githooks/pre-push` を `pnpm -r`/mise・`--filter @vaz/web`
  経由に更新する（biome + tsc + vitest + audit / pre-push E2E を維持）。
  _Boundary:_ `.githooks/pre-commit`, `.githooks/pre-push`
  _Depends:_ 6.2
  _Requirements:_ 1.9
- [x] 7.4 (P) `scripts/forbid-model-ids.sh` を作成し、`@vaz/config` 外のモデル ID 直書きを
  grep で検出して lint ステージを失敗させる。
  _Boundary:_ `scripts/forbid-model-ids.sh`
  _Depends:_ 6.2
  _Requirements:_ 1.8
- [x] 7.5 全ゲート（lint/typecheck/vitest/E2E/audit/model-id）を緑にし、`/api/chat` の
  Anthropic↔Ollama 切替が移行前と等価であること、RAG/WF が混入していないことを回帰検証する。
  _Boundary:_ `apps/web/tests/e2e/**`
  _Depends:_ 7.1, 7.2, 7.3, 7.4
  _Requirements:_ 1.10, NFR-1, NFR-5

### Implementation Notes

- **7.1 完了**: root `vitest.config.ts` を単一設定から **Vitest projects**（`test.projects`, Vitest 4.1.9）へ
  改修し、`apps/web/vitest.config.ts`（web=jsdom プロジェクト）を新設。`mise run test:run`（`pnpm exec vitest run`,
  root）が全プロジェクトを横断実行し、従来 `include: tests/**` から漏れていた `packages/agents/tests/chat-agent.spec.ts`
  （5.4, MockLanguageModelV4）を **node プロジェクトで捕捉**（17→**19 tests / 3→4 files**, exit 0, NFR-1）。
- **プロジェクト構成（境界内 2 ファイルのみ）**: (a) `web`=jsdom, `apps/web/vitest.config.ts` を path 参照
  （self-contained, `@→apps/web/src` + react plugin, standalone `pnpm --filter @vaz/web exec vitest run` も緑）。
  (b) `packages`=node, `packages/*/tests/**`（globals, `@vaz/*` subpath/workspace 解決のみで react/alias 不要）。
  (c) `root-legacy`=jsdom, repo-root `tests/**`（`@→./src` + `setupTests.ts`）。
- **[境界厳守 → root-legacy を暫定プロジェクト化]**: 7.1 の編集境界は config 2 ファイルのみ。旧 root `tests/{Chat,
  chat-schema,provider}.spec.ts` は root `./src` 複製（temporary duplication, Task 6）を import し、テスト移設や
  root src 撤去は **7.1 境界外**。よって「no regression（17 tests 緑維持）」と「境界厳守」を両立するため、
  root-legacy プロジェクトで暫定被覆し、UI テストの `apps/web/tests/**` 移設＋`./src` 撤去後に廃止する
  （その時点で web プロジェクトが実テストを持つ）。web プロジェクトは現状 0 件のため `passWithNoTests`（意図的空）。
- **[Vitest quirk / 非ゲート]**: root からの `--project web` 単独フィルタは、集約 0 件時に project 単位の
  `passWithNoTests` が「全体で 0 件」判定に効かず exit 1 になる（Vitest 既知挙動）。ただし **集約 run**
  （`mise run test:run`=exit 0, 19/19）と **standalone**（`pnpm --filter @vaz/web exec vitest run`=exit 0）は
  ともに緑で、いずれのゲート/ワークフローも `--project web` 単独を用いない。集約 run が「テストを必ず発見する」
  安全網を残すため root 全体 `passWithNoTests` は**設定しない**（全消失回帰の隠蔽を避ける）。
- **[coverage は root 集約]**: projects 併用時 coverage は root `test.coverage` に一元化（`src/**`・`src/app/**` 除外・
  thresholds 80/80 を従来設定のまま維持）。`test:coverage` は暫定 root `./src` を対象とし、packages coverage は
  移設収斂後に追加余地を残す。
- **検証**: `mise run test:run` **19 passed / 4 files, exit 0**（packages=2 / root-legacy=17 / web=0）、
  `mise run typecheck` exit 0（全 packages + apps/web + root tsc Done）、`mise run lint` `Checked 46 files … No fixes
  applied.`（45→46, apps/web/vitest.config.ts 追加, biome tabs/format 準拠）、`mise run audit` clean、
  `--frozen-lockfile` Already up to date（config-only 変更＝dep churn ゼロ）。
- **7 後続への申し送り**: 7.2（Playwright を `--filter @vaz/web` 化 + E2E を `apps/web/tests/e2e/**` へ移設）は
  E2E 除外（`tests/e2e/**`）と整合済み。root-legacy プロジェクトと root `./src`/`tests/*.spec.*` の撤去は、
  UI テスト移設（web プロジェクトへ）完了後に実施（7.5 全ゲート緑化のスコープで判断）。

- **7.2 完了**: `playwright.config.ts` の (a) `testDir` を `./tests/e2e` → `./apps/web/tests/e2e`、(b) `webServer.command` を
  root `pnpm dev`/`pnpm start` → **`pnpm --filter @vaz/web exec next {dev,start} --port ${PORT}`**（mise.toml の dev/start と一致）へ
  切替。既存 E2E 2 本（`home.spec.ts` / `chat-ollama.spec.ts`）を `apps/web/tests/e2e/**` へ **byte-identical 移設**（source 削除＝真の move、
  File Structure Plan の "Modify(move)"）。E2E は「実装後の検証」（tasks 冒頭のテスト規約）につき RED-Green ではなく移行後の回帰実行で検証。
- **[移設の安全性]**: `tests/e2e/**` への参照は playwright.config.ts の `testDir` のみ（grep 確認）。root tsconfig の `include` は `src`
  のみ（`tests` 非含）でゲート typecheck 非被覆、vitest は `tests/e2e/**` を exclude 済み（7.1）。よって move は他境界に回帰を与えない。
  `.githooks/pre-push` のコメントに旧パス記載が残るが 7.3 の境界（hooks 更新時に是正）。
- **[webServer が実 apps/web を起動]**: 6.2 で root `next.config.ts`/`./src` は temporary duplication のため root `pnpm dev` も一応動くが、
  R1.7 は「移設後アプリの回帰」を要求。`--filter @vaz/web` により E2E は **実 `@vaz/web`** を起動（WebServer ログに apps/web
  `instrumentation.ts` の telemetry 警告が出て起動元を実証）。
- **検証**: `mise run test:e2e` → **`10 passed / 2 skipped (23.5s)`**（chromium+firefox × home 5 本 = 10 緑、chat-ollama は
  `AI_PROVIDER!=ollama` で auto-skip ×2）。`mise run test:run` 19/19（回帰なし、e2e は vitest 対象外）、`mise run typecheck` exit 0、
  `mise run lint` `Checked 46 files … No fixes applied.`（move は net-zero、config 編集のみ）、`mise run audit` clean、
  `--frozen-lockfile` Already up to date。

- **7.3 完了**: `.githooks/pre-commit`・`pre-push` を **mise タスク経由**（bare `pnpm exec` を廃し、mise.toml を正本化 ―― CLAUDE.md/AGENTS.md）へ更新。
  - **pre-commit**: 4 段を `mise run lint`→`typecheck`→`test:run`→`audit` に置換。要は `tsc --noEmit`（root 単体）→ `mise run typecheck`
    （`pnpm -r run typecheck` + `[ -d src ]` ガード root tsc）でワークスペース対応化。biome/vitest/audit は元来全域だが mise 経由で DRY 化。
    model-id ゲート（`lint:model-ids`）は mise.toml の設計どおり集約 `mise run check`（NFR-2）側で enforce し pre-commit には含めない
    （mise.toml コメント「check = pre-commit 相当 + model-id」に整合）。
  - **pre-push**: `pnpm exec playwright test` → `mise run test:e2e`。webServer の `--filter @vaz/web` 起動は 7.2 で config 側に配線済み。
    Ollama 自動検出 → `export AI_PROVIDER=ollama` の分岐は維持（mise は親 env を継承）。コメントの旧パス `tests/e2e/chat-ollama.spec.ts`
    を `apps/web/tests/e2e/chat-ollama.spec.ts`（7.2 移設後）へ是正。
- **[mise on PATH の健全性]**: 現行フックが依存する `pnpm` は mise 管理（mise.toml `[tools] pnpm=11`）＝mise が PATH 前提。実測で
  `sh -c 'command -v mise'` → `/opt/homebrew/bin/mise`（Homebrew 由来で shim 非依存）。よって bare→mise 化は新規リスクを持ち込まない。
  Edit で編集し exec bit（`-rwxr-xr-x`）維持。biome は shell スクリプト非対象で lint 影響なし。
- **[FLAG → 7.5 トリアージ]**: pre-push 実行時 Ollama 検出下で E2E `12 passed` になったが、WebServer ログに `model 'llama3.2' not found`。
  `chat-ollama.spec.ts` は `getByText(/pong/i).last()` を assert し、**ユーザー入力文自体**（"Reply with … pong"）が "pong" に一致するため
  モデル未取得でも緑になる（false-green の余地）。**7.2 で verbatim 移設した既存仕様の潜在弱点**で 7.3 は非導入・境界外。7.5 の
  Anthropic↔Ollama 等価検証時に、AI 応答を厳密に判定するアサーション（例: user バブル除外／応答ロールで限定）へ是正を検討。
- **検証（フック実行）**: `sh .githooks/pre-commit` → 4 段緑・`[pre-commit] ✅ all checks passed`（test:run 19/19、audit clean）。
  `sh .githooks/pre-push` → `12 passed (12.7s)`・`[pre-push] ✅ all checks passed`（Ollama 検出で ollama 分岐実行）。
  標準ゲート: `mise run lint` 46 files clean、`typecheck` exit 0、`test:run` 19/19、`audit` clean、`--frozen-lockfile` Already up to date。

- **7.4 完了**: `scripts/forbid-model-ids.sh`（R1.8/ADR-5）を新設。`apps/**`・`packages/**` の `*.ts[x]` を grep し、`@vaz/config` の
  allow-list 以外に直書きされた LLM モデル ID を検出して exit 1（lint ステージ失敗）。mise 配線（`lint:model-ids` → `check`）は
  Task 1.3 で既存のため**本タスクの境界は script のみ**（mise.toml 非編集）。作成により skip → enforce へ自動切替。
- **[検出パターン]**: `claude-[a-z0-9]|llama-?[0-9]|gpt-[0-9]|gemini-[0-9]|qwen[0-9]|mistral-[a-z0-9]`。サポート 2 プロバイダ
  （anthropic/ollama）の claude-/llama を主軸に、非対応他社（gpt/gemini/qwen/mistral）を防御的トリップワイヤとして含む
  （Provider-Agnostic, OpenAI 非対応）。
- **[carve-out（ADR-5）]**: (a) `packages/config/**`（model-allowlist.ts=正本 + provider）、(b) `packages/schemas/src/env.ts`
  （env `.default()`=env carve-out）、(c) テスト（`*.spec.ts[x]` / `**/tests/**`、解決結果を assert）。走査範囲は go-forward 構成の
  `apps/**`・`packages/**` に限定し、移行期の root `./src`（temporary duplication, 7.5 で撤去予定）は非対象。
- **[非空虚性の実証（mutation）]**: (RED) `apps/web/src/__probe_modelid.ts` に `"claude-opus-4-8"` を植込み → **検出 exit 1**。
  (GREEN) clean tree は config/env が実 ID を含むにもかかわらず **exit 0**（carve-out 有効）。(carve-out) `.spec.ts` 内の
  `"llama3.2"` は **非検出 exit 0**。probe は全て削除。
- **検証**: `bash scripts/forbid-model-ids.sh`（clean）exit 0、`mise run lint:model-ids` ✅ clean、
  **`mise run check` exit 0**（5 段: lint 46 files / typecheck / test:run 19/19 / audit clean / lint:model-ids ✅ ―― NFR-2 集約ゲート）。
  `--frozen-lockfile` up to date。exec bit `-rwxr-xr-x`。

- **7.5 完了（Phase 1 回帰検証ゲート）**: 全ゲート緑化 + Anthropic↔Ollama 等価 + RAG/WF 非混入を検証。境界は `apps/web/tests/e2e/**`。
- **[全ゲート緑（lint/typecheck/vitest/E2E/audit/model-id）]**: `mise run check` **exit 0**（lint 47 files clean / typecheck 全 Done /
  test:run 19/19 / audit clean / lint:model-ids ✅）。E2E: `mise run test:e2e`（既定=anthropic, 鍵なし）**10 passed / 4 skipped**、
  `mise run test:e2e:ollama` **10 passed / 4 skipped**。
- **[Anthropic↔Ollama 等価（NFR-5）]**: プロバイダ切替は env 駆動 `@vaz/config#resolveModel`（Task 3.2 で byte-identical 移設）で、
  `tests/provider.spec.ts`（anthropic→`claude-opus-4-8` / ollama→modelId・provider）が単体で契約を固定。route は薄いアダプタで
  UI stream 形状を保存（R1.7）。E2E は **対称な 2 spec** で両プロバイダの往復を検証: `chat-ollama`（`AI_PROVIDER=ollama` かつ
  対象モデル pull 済み時）・`chat-anthropic`（`AI_PROVIDER=anthropic` かつ `ANTHROPIC_API_KEY` 有時）。いずれも条件未達で clean に skip。
- **[chat-ollama false-green FLAG（7.3）を解決]**: 旧 spec は `getByText(/pong/i).last()` がユーザー入力文（"…pong"）に一致し、
  モデル未 pull でも緑になった。修正: (a) skip 条件を「エンドポイント到達」→「対象モデルが pull 済み」へ厳格化（`/v1/models` の
  `data[].id` を照合）、(b) アサーションを **assistant（"AI"）タイルにスコープ**（`getByText("AI").first().locator("xpath=..")`）し、
  ユーザー入力のエコーではなく AI 応答に "pong" を要求。**非空虚性の実証**: llama3.2 未 pull の本機で `test:e2e:ollama` が
  旧「12 passed（うち 2 が false-green）」→ 新「10 passed / **4 skipped**（ollama 往復は精密 skip、false-green 消滅）」。
- **[R1.10 RAG/WF 非混入]**: 構造検査で Phase 2+ 成果物ゼロを確認 ―― `packages/{rag,evals}`・`apps/worker`・`docker-compose.yml` 不在、
  `schemas/src/{rag,workflows,eval}.ts`・`agents/src/{supervisor,approval-policy,prompt,audit-hook}.ts`・`config/src/embedding.ts`・
  `tools/src/{email,allowlist}.ts` 不在、`drizzle|pgvector|inngest|temporal|embedMany|@vaz/{rag,evals,worker}` 参照ゼロ。Phase 1 の
  package src は env/chat/deps・provider/model-allowlist/telemetry・time/index・chat-agent/index の想定集合に一致。
- **[FLAG トリアージ] build（`/_global-error` prerender）**: `next build` は **`✓ Compiled successfully`** 後、`/_global-error` の
  prerender で `TypeError: Cannot read properties of null (reading 'useContext')` により exit 1。HEAD 由来（1.2 の `/_not-found` と同一クラス、
  React 19.2 × Next 16 の error-page prerender）で **移行の回帰ではない**。`build` は 7.5 の必須ゲート列（lint/typecheck/vitest/E2E/audit/model-id）
  に**非含**、修正は 7.5 境界（e2e）外のため本タスクでは非対応。**要フォローアップ**（custom `global-error`/`not-found` or Next/React 設定）。
- **[残タスク（Phase 1 janitorial, 全 Phase 1 タスク境界外）]**: root `./src`・`tests/{Chat,chat-schema,provider}.spec.ts`・root `next.config.ts` は
  temporary duplication で残存（root-legacy vitest project + root tsc guard で緑）。RAG/WF・等価性・ゲートに影響しない dead duplication のため
  correctness には無害。撤去（と root-legacy project の廃止）は独立の cleanup として別途実施を推奨。

---

**Task 7（ワークスペース品質ゲート配線 + Phase 1 回帰検証）完了**: 7.1–7.5 全緑。Vitest projects（web=jsdom / packages=node）で `@vaz/agents`
単体テストを恒久ゲート化、Playwright を `--filter @vaz/web` 化 + E2E を apps/web へ移設、git hooks を mise/workspace 対応化、モデル ID 直書き
ゲート（forbid-model-ids）を enforce 化。`mise run check`（NFR-2 集約: lint/typecheck/vitest/audit/model-id）exit 0、E2E 両プロバイダ対称検証、
R1.10 段階分離を実証。**Phase 1（R1 / NFR-1,2,3,5,6,7）完了**。既知 FLAG: build の error-page prerender（React19.2×Next16, HEAD 由来・非回帰）は
フォローアップ。root `./src` duplication は janitorial cleanup 待ち。次フェーズは Task 8（Phase 2: RAG 永続化基盤）。

---

## 8. (P) RAG 永続化基盤とプロビジョニング（Phase 2）

PostgreSQL + pgvector を docker-compose でプロビジョニングし、Drizzle スキーマ・
埋め込み解決・env 拡張を用意する（埋め込み次元は DDL で固定）。

_Boundary:_ `docker-compose.yml`, `packages/rag/package.json`, `packages/rag/src/db/schema.ts`, `packages/config/src/embedding.ts`, `packages/schemas/src/env.ts`, `pnpm-workspace.yaml`
_Depends:_ 7
_Requirements:_ 1.2, 2.1, 2.2, 2.3

- [x] 8.1 (P) `docker-compose.yml` に postgres+pgvector の開発サービスを定義する。
  _Boundary:_ `docker-compose.yml`
  _Depends:_ 7
  _Requirements:_ 2.2
- [x] 8.2 `packages/rag/package.json` を作成し `@vaz/rag` として定義する。
  _Boundary:_ `packages/rag/package.json`
  _Depends:_ 7
  _Requirements:_ 2.1
- [x] 8.3 `src/db/schema.ts` に Drizzle スキーマ（document/chunk/embedding、`drizzle-zod`、
  `vector(N)` は DDL 時に次元固定、`provider`/`dim` 列で混在検出）を定義する。
  _Boundary:_ `packages/rag/src/db/schema.ts`
  _Depends:_ 8.2
  _Requirements:_ 2.2, 2.3
- [x] 8.4 (P) `packages/config/src/embedding.ts` に `resolveEmbeddingModel(env?)`
  （既定 Ollama `nomic-embed-text`、`embedMany` 経由）を実装する。
  _Boundary:_ `packages/config/src/embedding.ts`
  _Depends:_ 7
  _Requirements:_ 2.3
- [x] 8.5 (P) `packages/schemas/src/env.ts` に `AI_EMBEDDING_PROVIDER` 等の
  埋め込みプロバイダ設定を追加し Zod で検証する。
  _Boundary:_ `packages/schemas/src/env.ts`
  _Depends:_ 7
  _Requirements:_ 2.3
- [x] 8.6 (P) `pnpm-workspace.yaml` に `pg` 等の install script を `allowBuilds` へ
  監査追記する（default deny 方針を維持）。
  _Boundary:_ `pnpm-workspace.yaml`
  _Depends:_ 7
  _Requirements:_ 1.2

### Implementation Notes

- **8.1 完了**: `docker-compose.yml`（新規、単一編集境界）を作成。`db` サービス =
  `pgvector/pgvector:pg17`（Postgres 17 に `vector` 拡張バイナリを同梱）で R2.2「PostgreSQL +
  pgvector を docker-compose で開発プロビジョニング」を充足。Compose v2 スキーマ（obsolete
  `version:` は不使用、top-level `name: vaz-ai`）。認証情報は `${POSTGRES_USER:-vaz}` 等の env
  補間で throwaway default（`vaz`/`vaz`/`vaz`）を持ちつつ `.env` から上書き可（後続の DATABASE_URL
  と同一 host:port を指せる）。`pgdata` named volume（`.gitignore` の named volume は非追跡）+
  `pg_isready` healthcheck（interval 5s / retries 10）。ポートは `${POSTGRES_PORT:-5432}:5432`。
- **境界順守（拡張 DDL は非スコープ）**: `CREATE EXTENSION vector` および全スキーマは Drizzle
  migration（`@vaz/rag`, Task 8.3）が所有。本ファイルは pgvector 拡張を**利用可能**にするサーバの
  provision に限定（image 選択で拡張バイナリを同梱）。init SQL script を置くと編集境界
  `docker-compose.yml` 外になるため追加せず、8.3 に委譲。worker/engine サービスは R3.1（Task 15）で追記。
- **TDD（no-src / no-test-boundary → config 検証で RED→GREEN）**: docker-compose.yml は `src/`
  ユニットロジックではないため Vitest test 境界を持たない（Constitution P2 の Red-Green は src 対象）。
  代替として `docker compose config` を RED→GREEN の検証点に採用: RED = `no configuration file
  provided: not found`（file 不在）→ GREEN = merged config が exit 0 でレンダリング（YAML 構文 /
  スキーマ / env 補間 / healthcheck / volume / ports 全て解決）。
- **[FLAG] live up-test は本環境で registry egress ブロックにより不可**: `docker compose up -d db`
  は `pgvector/pgvector:pg17` の pull が `registry-1.docker.io` へ到達できず `context deadline
  exceeded`（sandbox の外部 egress 制限、image 未キャッシュ）。よって「実コンテナ起動 →
  `CREATE EXTENSION vector` 実行」までの end-to-end 実証は本セッションでは未実施（compose 定義の
  不具合ではなく環境制約）。ネットワーク到達可能な開発機での 8.3 migration 適用時に拡張作成を実証する。
- **検証**: `docker compose config` exit 0（merged config 正常レンダリング）、`mise run lint`
  53 files clean（biome、YAML は非対象だが回帰なし）、`mise run typecheck` exit 0、`mise run
  test:run` 8 files / 31 passed（回帰なし）。
- **8.2 完了**: `packages/rag/package.json` を 2.1/3.1/4.1/5.1 と同型の source-only(JIT)パッケージ
  `@vaz/rag` として定義（`type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }`
  wildcard / `typecheck` echo marker）。consumers（9.6 で `@vaz/agents` が retrieval capability を登録）は
  `@vaz/rag/retrieve/index` 等の subpath で import する。dep グラフは一方向を維持
  （schemas → config/tools/**rag** → agents → web、rag は tools を import せず agents と並列）。
- **単一編集境界としての前方宣言（`packages/rag/package.json` は 8.2 のみが編集境界）**: 後続の
  8.3(`src/db/schema.ts`)・9.2–9.5(`src/ingest`/`src/retrieve`/`src/tools`/`bin/ingest.ts`) は別境界で
  package.json を再編集できない。よって (a) **依存**は resolvable なもの（workspace + lockfile 既存）を先行宣言
  — `@vaz/config`(`workspace:*`、9.2 が `resolveEmbeddingModel`=8.4 を消費) + `@vaz/schemas`(`workspace:*`、
  9.1 `RetrievedChunk`/`Citation` 契約) + `ai`(`^7.0.14`、9.2 `embedMany` / 9.4 `tool()`) +
  `zod`(`^4.4.3`、9.4 `inputSchema` / drizzle-zod）。全て root/lockfile 既存の解決済みバージョンで
  **新規外部依存ゼロ** → `pnpm install` は `downloaded 0, added 0`（supply-chain 判断不要）。(b) **scripts**は
  9.5 の CLI（`pnpm --filter @vaz/rag ingest ./docs`, R2.6）が package.json script を要するが 9.5 境界は
  `bin/ingest.ts` のみ → `ingest: "node bin/ingest.ts"` を先行宣言（Node 24 native TS 実行、source-only 方針に整合。
  file は 9.5 で作成＝それまで inert、gate 非被覆）。
- **[deferred] drizzle-orm / drizzle-zod / pg は 8.2 で意図的に非宣言**: これらは lockfile 未存在の**新規外部依存**
  （`grep -cE 'drizzle|/pg@' pnpm-lock.yaml` = 0）。3.1→3.4 の `@ai-sdk/otel` deferral 前例に倣い、
  drizzle は要件 owner の **8.3**（schema, R2.2/2.3）が package.json へ境界拡張して宣言、`pg` の install script は
  **8.6**（`allowBuilds` 監査追記, R1.2, default deny 維持）が扱う。8.2 で宣言すると (i) 新規 install で
  `minimumReleaseAge`/`allowBuilds` の supply-chain 決定が 8.6 前に発火し矛盾、(ii) `pg` の allowBuilds 未追記時
  `pnpm install` がエラー化するため、resolvable 集合に限定した。**pgvector 列型は drizzle-orm の `vector` を用い
  別 npm パッケージ不要**（8.3 で確定）。
- **TDD（no-src / no-test-boundary → member 登録で RED→GREEN）**: package.json は `src/` ユニットロジックでなく
  test 境界も無い（File Structure Plan は rag test を 10.x recall.spec まで非掲載）。2.1/3.1/4.1/5.1 と同じ member
  検証で RED→GREEN: RED = `pnpm --filter @vaz/rag run typecheck` → `No projects matched the filters`（未登録）→
  GREEN = 同コマンドが echo marker を実行（登録済み、members 5→6）。
- **検証**: `pnpm install` = `all 7 workspace projects` / `downloaded 0, added 0` / supply-chain policies pass、
  `pnpm install --frozen-lockfile` = `Already up to date`（churn ゼロ）、`pnpm --filter @vaz/rag run typecheck` 実行成功、
  `mise run lint` = `Checked 54 files … No fixes applied`（53→54）、`mise run typecheck` exit 0、
  `mise run test:run` = 8 files / 31 passed（回帰なし）。
- **8.3 完了**: `packages/rag/src/db/schema.ts` に Drizzle スキーマを定義（R2.2/2.3）。3 テーブル:
  `document`（id uuid pk defaultRandom / source text notNull / metadata jsonb / ingested_at timestamptz
  notNull defaultNow、R2.1 ingest 単位）→ `chunk`（id / document_id uuid fk→document onDelete cascade /
  ordinal int / content text、R2.1 chunking）→ `embedding`（chunk_id uuid **pk かつ** fk→chunk cascade＝1:1 /
  `vector("vector", { dimensions: EMBEDDING_DIM })` notNull / dim int / provider text）。drizzle-zod の
  `createInsertSchema`/`createSelectSchema` で 3 テーブル分の insert/select 契約を生成（R2.2 `drizzle-zod`）。
- **次元 DDL 固定（R2.2/2.3）**: `EMBEDDING_DIM = 768`（Ollama `nomic-embed-text` 既定次元）を単一正本として
  export し、`vector(768)` 列と `check("embedding_dim_fixed", sql\`dim = 768\`)` の双方が参照。プロバイダ変更で
  次元不一致（例 768→1536）は DB 境界で CHECK 違反として拒否 → migration + 全 re-ingest を強制。`provider`/`dim`
  列は notNull で保持し、**provider 混在の実行時検出は 9.2 ingest ガード**（同一次元でも別 provider の混在は静的
  CHECK 不能＝runtime 判定）に委譲。model ID 文字列は非記述（`nomic-embed-text` は @vaz/config 8.4 が所有、
  schema は 768 の整数のみ＝forbid-model-ids gate 非該当）。
- **[解決] 単一編集境界 × 新規依存（3.4 前例踏襲）**: 8.3 の宣言境界は `src/db/schema.ts` のみだが drizzle は
  `packages/rag/package.json`（8.2 のみが編集境界）への追加が必要。3.4 が config/package.json を境界拡張した前例に
  倣い **rag/package.json へ境界拡張**して `drizzle-orm@^0.45.2` + `drizzle-zod@^0.8.3` を宣言（8.2 の申し送り通り）。
  supply-chain 監査: 両者 latest stable（drizzle-orm 0.45.2 / drizzle-zod 0.8.3、共に数ヶ月前公開で
  `minimumReleaseAge:1440` 充足）、**lifecycle install script 無し**（`postinstall`/`install`/`prepare` 不在）→
  `allowBuilds` 追記不要（`pg` の allowBuilds は 8.6 スコープ、drizzle と分離できる理由）。drizzle-zod peer
  `zod: "^3.25.0 || ^4.0.0"` は本 repo `zod@^4.4.3` と互換（store は `drizzle-zod@0.8.3_..._zod@4.4.3` で解決）、
  `drizzle-orm: ">=0.36.0"` を 0.45.2 が充足。pgvector 列型は drizzle-orm 同梱 `vector` を用い別 npm パッケージ不要。
  `pnpm install` = `+2`（`downloaded 2, added 2`）/ supply-chain policies pass / `--frozen-lockfile` clean。
- **TDD（no durable-test-boundary → ephemeral probe, RED→GREEN）**: rag の durable test 境界は 10.x（recall.spec）。
  よって 3.4/4.2/5.2 と同じ ephemeral probe（`packages/rag/tests/__schema.probe.spec.ts`、`packages` project=node env、
  実行後削除）で RED（`../src/db/schema` 不在 → import 解決失敗、`Test Files 1 failed / no tests`）→ GREEN（3 tests:
  3 テーブルの列名 / `EMBEDDING_DIM===768` / drizzle-zod insert schema が有効行を受理・`source` 欠落を拒否）→ 削除。
- **検証**: probe GREEN 3 passed、isolated tsc（`--ignoreConfig --strict --moduleResolution bundler --types node`）
  **exit 0**（drizzle-orm/pg-core + drizzle-zod 型解決）、`mise run lint` = `Checked 55 files … No fixes applied`
  （54→55）、`mise run typecheck` exit 0、`mise run test:run` = 8 files / 31 passed（probe 削除後・回帰なし）、
  `pnpm install --frozen-lockfile` = `Already up to date`。gate typecheck は source-only echo marker のため schema.ts
  非被覆 → 最終被覆は consumer 配線（9.2/9.3 が import）+ 7.5 相当の統合。
- **8.4 完了**: `packages/config/src/embedding.ts` に `resolveEmbeddingModel(env = process.env)` を実装（R2.3）。
  3.2 `resolveModel` と同型（env 駆動・shared provider layer）。既定は Ollama `nomic-embed-text`（`embeddingModel(id)`
  ＝非 deprecated API、`textEmbeddingModel` は deprecated）で `@ai-sdk/openai-compatible` を `OLLAMA_BASE_URL`
  （`parseAiEnv` で検証済み）へ向ける。戻り値は `ai` の `EmbeddingModel`（v7 は union 型・generic 無し）、
  9.2/9.3 が `embedMany` で消費（構築は lazy＝本関数は network 非発火）。
- **[設計] 8.5（並列）への非依存＝防御的 env 直読み（3.4 telemetry 前例）**: 8.4 の Depends は 7 のみで 8.5
  （env schema へ `AI_EMBEDDING_PROVIDER` 追加）に依存しない。よって 3.4 が Langfuse env を防御的直読みした前例に倣い、
  `AI_EMBEDDING_PROVIDER`（既定 `ollama`）/ `AI_EMBEDDING_MODEL`（既定 `nomic-embed-text`）を env から直読み
  （空文字→undefined 正規化）し単体成立させた。8.5 が Zod enum で正式検証を追加（R2.3「Zod env schema が embedding
  設定を検証」）＝正式検証は 8.5、resolver は 8.4 の責務分離。未対応 provider は fail-fast で throw（誤設定検出）。
- **[R1.8/ADR-5] `nomic-embed-text` 直書きの合法性**: `forbid-model-ids.sh`（7.4）は `packages/config/**` を
  carve-out で全除外（`grep -vE '(^|/)packages/config/'`）し、検出パターン（`claude-|llama|gpt-|gemini-|qwen|mistral-`）
  にも `nomic` 非含 ―― 二重に安全。`DEFAULT_EMBEDDING_MODEL_ID` は model-allowlist.ts の `DEFAULT_MODEL_ID` と同じく
  config を唯一の合法在処とする方針に整合（`lint:model-ids` ✅ 実測）。
- **TDD（no durable-test-boundary → ephemeral probe, RED→GREEN）**: config は durable test 境界を持たない。
  3.4 と同じ ephemeral probe（`packages/config/tests/__embedding.probe.spec.ts`、`packages` project=node env、実行後削除）で
  RED（`../src/embedding` 不在 → import 失敗、`Test Files 1 failed / no tests`）→ GREEN（3 tests: 既定 Ollama
  `nomic-embed-text`＝`model.modelId`/`model.provider` を network なしで assert / `AI_EMBEDDING_MODEL` override /
  未対応 provider で throw）→ 削除。
- **検証**: probe GREEN 3 passed、isolated tsc（`--ignoreConfig --strict --moduleResolution bundler --types node`）
  **exit 0**（`@ai-sdk/openai-compatible`+`@vaz/schemas/env`+`ai` 解決）、`mise run lint:model-ids` ✅、
  `mise run lint` = `Checked 56 files … No fixes applied`（55→56）、`mise run typecheck` exit 0、
  `mise run test:run` = 8 files / 31 passed（probe 削除後・回帰なし）。gate typecheck は source-only echo marker のため
  embedding.ts 非被覆 → 最終被覆は 9.2 ingest / 9.3 retrieve の import + 統合。
- **8.5 完了**: `packages/schemas/src/env.ts`（schemas leaf）の `aiEnvSchema` に埋め込み env を追加（R2.3）:
  `AI_EMBEDDING_PROVIDER: z.enum(["ollama"]).default("ollama")` + `AI_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text")`。
  併せて **`parseAiEnv` 本体にも両フィールドを追記**（`emptyToUndefined` 正規化）――
  `aiEnvSchema.parse({...})` は明示的に渡すキーのみ検証するため、schema 追加だけでは実 env 値が検証されない（両方必須）。
- **[設計] enum = `["ollama"]`（実装済み provider のみ）**: 8.4 resolver が現状 `ollama` のみ対応（他は throw）・
  chat の `AI_PROVIDER` enum も実装済み provider のみを列挙する前例に整合。spec の OpenAI/Voyage は「ポリシー許可時の
  将来オプション」で Phase 2 実装タスク無し → 将来導入時に **enum + 8.4 switch を同時拡張**。単一メンバー enum でも Zod は
  非対応値を env 境界で reject（R2.3「Zod env schema が embedding 設定を検証」を充足、`voyage` → ZodError）。
- **[R1.8/ADR-5] 既定値の重複と drift**: `AI_EMBEDDING_MODEL` 既定 `nomic-embed-text` は env.ts（leaf、config を
  import 不可）と `@vaz/config/embedding.ts`（8.4 `DEFAULT_EMBEDDING_MODEL_ID`）の**両方**に出現＝chat モデル既定と同じ
  ADR-5 duplication。env.ts は forbid-model-ids gate の carve-out（`packages/schemas/src/env.ts:` 除外、かつ pattern に
  `nomic` 非含）で合法。既存 drift guard（`packages/config/tests/model-allowlist.spec.ts`）は chat 既定
  （`ANTHROPIC_MODEL`/`OLLAMA_MODEL` vs `DEFAULT_MODEL_ID`）のみ検査で本追加に非干渉（実測: test:run 31 passed 不変）。
- **[整合] 8.4 との合流**: 8.4 resolver は `AI_EMBEDDING_PROVIDER`/`AI_EMBEDDING_MODEL` を防御的直読みし、内部で
  `parseAiEnv(env)` を呼ぶ。8.5 後はその `parseAiEnv` 呼び出しが embedding env も検証（enum 外は resolver の自前 throw
  より前に ZodError で fail-fast）。両者の既定値は同値（`ollama`/`nomic-embed-text`）で divergence なし。
- **TDD（no durable-test-boundary → ephemeral probe, RED→GREEN）**: env.ts は schemas leaf で durable test 境界を持たない。
  ephemeral probe（`packages/schemas/tests/__env-embedding.probe.spec.ts`、`packages` project=node env、実行後削除）で
  RED（フィールド不在 → 既定 undefined・`voyage` 非 reject、**4 failed**）→ GREEN（**4 passed**: 既定 `ollama`/`nomic-embed-text` /
  空文字正規化 / model override / `voyage` を Zod reject）→ 削除。
- **検証**: probe GREEN 4 passed、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 56 files … No fixes applied`
  （env.ts の変更は既存ファイル内追記のためファイル数不変）、`mise run typecheck` exit 0、`mise run test:run` = 8 files /
  31 passed（probe 削除後・ADR-5 drift guard 含め回帰なし）、`pnpm install --frozen-lockfile` = `Already up to date`
  （新規依存なし）。
- **8.6 完了**: `pnpm-workspace.yaml` の `allowBuilds` に `pg: false` を監査追記（R1.2、default-deny 維持）。
  **監査結論**: `pg@8.22` は lifecycle build script を持たない（`scripts` は `test` のみ、依存ツリー
  pgpass/pg-pool/pg-types/pg-protocol/pg-connection-string/pg-cloudflare も純 JS、native な `pg-native` 不使用）。
  よって `strictDepBuilds`（既定 true）下でも install はブロックされないが、DB ドライバの供給網判断を**明示記録**し、
  将来版が install script を追加した場合のフェイルセーフとして `false`（deny）で宣言（既存の proactive-deny 慣行
  = `sharp`/`@parcel/watcher` に整合）。dependency としての `pg` 追加は 9.x の ingest/retrieve 実装。
- **[確認] allowBuilds は実 pnpm v11 フィールド**: pnpm docs で「package matcher → bool の map、`true` 許可/`false` 拒否」
  と確認。未掲載かつ build script を持つ依存は `strictDepBuilds=true`（既定）で **install エラー**（AGENTS.md の記述と一致）。
  scriptless の `pg` エントリは gate 対象の script が無いため inert（install 警告・placeholder 自動追記なし）。
- **TDD（no-src / config audit → install 検証で RED→GREEN）**: pnpm-workspace.yaml は `src/` ロジックでなく test 境界も無い。
  RED = `allowBuilds` に `pg` エントリ不在（grep）→ GREEN = エントリ追記後も `pnpm install` が「Lockfile passes supply-chain
  policies / Already up to date」でクリーン（pg の build prompt・placeholder 自動追記なし）。
- **検証**: `pnpm install` = supply-chain policies pass / `Already up to date`（エラー・警告なし）、
  `pnpm install --frozen-lockfile` = `Already up to date`（allowBuilds は resolution 非影響＝lockfile churn ゼロ）、
  `mise run lint` = `Checked 56 files … No fixes applied`、`mise run typecheck` exit 0、`mise run test:run` = 8 files /
  31 passed（回帰なし）、`mise run audit` = `No known vulnerabilities found`。

**Task 8（RAG 永続化基盤とプロビジョニング）完了**: 8.1–8.6 全緑（Phase 2 の RAG 永続化基盤を確立）。
docker-compose(pgvector, 8.1) + `@vaz/rag` member(8.2) + Drizzle schema(document/chunk/embedding, `vector(768)` DDL 固定 +
provider/dim 混在検出, 8.3) + `resolveEmbeddingModel`(既定 Ollama nomic-embed-text, 8.4) + env 拡張(`AI_EMBEDDING_PROVIDER`/
`AI_EMBEDDING_MODEL` Zod 検証, 8.5) + `pg` の allowBuilds 監査(default-deny, 8.6)。新規外部依存は drizzle-orm/drizzle-zod のみ
（install script 無し）。**次は Task 9（RAG ingest / retrieve capability）**。
**9 への申し送り（重要）**: (1) `pg` を dependency として `@vaz/rag/package.json` へ追加（9.2/9.3 の DB 接続）―― install script
無しのため allowBuilds は 8.6 で監査済み、追加時も strictDepBuilds エラーは出ない見込み。(2) schema.ts / embedding.ts は現状
未 import で gate typecheck 非被覆（source-only echo marker）―― 9.2/9.3 の import で初被覆。(3) 実 PostgreSQL への DDL 適用
（`CREATE EXTENSION vector` / `vector(768)` / CHECK）は 8.1 の image pull ブロックで本セッション未実証 ―― 到達可能環境での
migration（drizzle-kit 導入時、esbuild postinstall の allowBuilds 監査が新たに必要）で実証する。(4) embedding 既定の
drift guard（env.ts ↔ `DEFAULT_EMBEDDING_MODEL_ID`）は未整備（8.5 申し送り）。

---

## 9. RAG ingest / retrieve capability（Phase 2）

`ingest/`（loader→chunk→embed→upsert）と `retrieve/`（reranker なしのベクトル検索）を
実装し、`RetrievedChunk`/`Citation` 契約で retrieval を capability として export する。

_Boundary:_ `packages/schemas/src/rag.ts`, `packages/rag/src/ingest/index.ts`, `packages/rag/src/retrieve/index.ts`, `packages/rag/src/tools.ts`, `packages/rag/bin/ingest.ts`, `packages/agents/src/chat-agent.ts`
_Depends:_ 8
_Requirements:_ 2.1, 2.4, 2.6, 2.7

- [x] 9.1 `packages/schemas/src/rag.ts` に `RetrievedChunk`/`Citation` 契約を定義する。
  _Boundary:_ `packages/schemas/src/rag.ts`
  _Depends:_ 8.3
  _Requirements:_ 2.4
- [x] 9.2 `src/ingest/index.ts` に loader→chunk→embed→upsert パスを実装する
  （provider/dim 整合ガード付き）。
  _Boundary:_ `packages/rag/src/ingest/index.ts`
  _Depends:_ 8.3, 8.4, 9.1
  _Requirements:_ 2.1, 2.6
- [x] 9.3 `src/retrieve/index.ts` に reranker なしのベクトル検索を実装する。
  _Boundary:_ `packages/rag/src/retrieve/index.ts`
  _Depends:_ 8.3, 9.1
  _Requirements:_ 2.1, 2.7
- [x] 9.4 `src/tools.ts` に `createRetrievalCapability(deps)` を実装し、`RetrievedChunk`/`Citation`
  を返す検索ツールを export する（chat agent が引用付き回答に使用）。
  _Boundary:_ `packages/rag/src/tools.ts`
  _Depends:_ 9.3, 9.1
  _Requirements:_ 2.4
- [x] 9.5 `bin/ingest.ts` に CLI エントリを実装し `pnpm --filter @vaz/rag ingest ./docs`
  で end-to-end 取り込みできるようにする。
  _Boundary:_ `packages/rag/bin/ingest.ts`
  _Depends:_ 9.2
  _Requirements:_ 2.6
- [x] 9.6 `packages/agents/src/chat-agent.ts` を Modify し、`createChatAgent(deps)` が `deps` 経由で
  RAG retrieval capability（9.4）をツール登録して引用付き回答を生成できるようにする
  （Phase 1 の time ツールに追加、`RetrievedChunk`/`Citation` を回答へ反映、env/deps 駆動で後方互換）。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 9.4
  _Requirements:_ 2.4

### Implementation Notes

- **9.1 完了**: `packages/schemas/src/rag.ts`（新規、schemas leaf）に引用契約を定義（R2.4）。
  `retrievedChunkSchema`（retrieve 9.3 の 1 ヒット単位: `chunkId`/`documentId`=`z.uuid()`、
  `source`=`min(1)`、`ordinal`=`int().nonnegative()`、`content`、`score`）と `citationSchema`
  （回答提示用の軽量参照: `documentId`/`source`/`chunkId` のみ、本文・score は非携行）+ 各 `z.infer` 型
  `RetrievedChunk`/`Citation`。加えて純関数 `toCitation(chunk)` を同梱し projection を単一正本化
  （9.4 tool / 9.6 agent が再実装しない）。
- **[整合] 8.3 schema との型接合**: identity 列は Drizzle の `uuid`（`document.id`/`chunk.id`）に合わせ
  `z.uuid()`。`ordinal` は `chunk.ordinal`（integer notNull）に対応し 0 始まり＝`nonnegative()`。
- **[設計] `score` は range 非拘束（`z.number()`）**: cosine 類似度の実レンジは retrieve 9.3 が所有するため、
  契約側で `[0,1]` 等に clamp すると retriever が正当に生成する値を誤 reject しうる。意味論（大きいほど類似）は
  doc-comment に明記し検証は最小限に留める。`content` は untrusted corpus text＝R5.2 の明示区切りコンテキスト
  ブロック注入は agent（9.6）の責務で、本 module は型付けのみ。
- **[R1.8/ADR-5] model-id gate 非該当**: model 文字列を含まない（`lint:model-ids` ✅）。
- **TDD（durable test 境界あり → RED→GREEN）**: schemas は chat.spec.ts と同型の durable test 境界を持つため
  ephemeral probe ではなく durable `packages/schemas/tests/rag.spec.ts` を作成。RED = `@vaz/schemas/rag` 未解決
  （`Cannot find package … no tests`）→ GREEN = 11 tests（well-formed 受理 / 非 UUID documentId・chunkId reject /
  負・非整数 ordinal reject / 空 source reject / `toCitation` の projection と content・score 非漏洩）。
- **検証**: rag.spec.ts 11 passed、`mise run test:run` = 9 files / 42 passed（8/31 → 9/42、回帰なし）、
  `mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = Checked 58 files / No fixes applied
  （初回 100 char 超の 1 行を `lint:fix` で wrap＝formatting のみ、logic 変更なし）。gate typecheck は source-only
  echo marker のため rag.ts 非被覆 → 最終被覆は 9.2/9.3/9.4 の import + 統合。
- **9.2 完了**: `packages/rag/src/ingest/index.ts`（新規）に loader→chunk→embed→upsert パスを実装（R2.1/2.6）。
  ADR-3 の deps-closure に倣い注入シーム上で orchestrator を構成: `ingest(corpusPath, deps)` の `deps` は
  `store`（persistence port）・`embed`（`EmbedBatch`）・任意 `loadCorpus`/`chunk`/`logger`。これにより
  network/DB なしで全経路をユニット検証可能（`createChatAgent` の MockLanguageModel seam と同じ発想）。
- **[R2.2/2.3] provider/dim 整合ガード（8.3 が本タスクへ委譲した runtime 検出）**: `assertEmbeddingConsistency`
  （count 一致 + `dim===EMBEDDING_DIM` + 各 vector 長）と `assertNoProviderMixing`（既存 profile と provider/dim
  照合、相違で throw）を純関数で export。`vector(768)` CHECK は次元逸脱を弾くが「同一次元での provider 混在」は
  静的に不能＝ingest 時 runtime 判定（schema.ts コメントの委譲を充足）。相違時は「migration + 全 re-ingest」を要求。
- **chunking**: `chunkText(text, {size=1000, overlap=200})` = 固定長ウィンドウ + overlap（MVP, R2.7 reranker なし）。
  決定的・全域被覆（trim 後の全文字が最低 1 window に載る、連続 window は厳密に overlap 文字共有）、空/空白のみは `[]`。
  `overlap>=size` 等は fail-fast。
- **adapters（composition-root 配線）**: `createDrizzleIngestStore(db)`（driver-agnostic `PgDatabase<PgQueryResultHKT>`
  型 ―― ingest は `pg` に非結合、tx 内で source 単位 delete→insert の冪等 upsert + returning で ordinal→chunkId 対応付け）、
  `createEmbedder(model, provider)` / `createDefaultEmbedder(env)`（`@vaz/config#resolveEmbeddingModel` + `embedMany`,
  lazy＝network 非発火）、`defaultFileCorpusLoader`（`.md`/`.mdx`/`.txt` 再帰読取、source=相対パス）。実 DB/Ollama 経路は
  9.5 CLI・到達可能環境で実証（8.1 image-pull FLAG と同クラスの deferral）。
- **[8.2/8.6 申し送り消化] `pg` 依存追加（package.json 境界拡張, 8.3 前例）**: `@vaz/rag/package.json` に `pg@^8.13.1`
  （dependency, 9.5 bin / 9.6 web が Pool 構築）+ `@types/pg@^8.11.10`（devDependency, node-postgres drizzle 型）を追加。
  ingest 自体は driver-agnostic 型で `pg` 非 import だが、本 package が DB 書込 adapter の初出＝DB ドライバ宣言の所有者。
  `pg` は install script 無し（8.6 監査済 `allowBuilds: pg=false` は inert）→ `pnpm install` = `+17`/supply-chain pass、
  `--frozen-lockfile` clean、`mise run audit` = No known vulnerabilities。
- **TDD（durable test 境界）**: guard は安全性クリティカルのため 8.x の ephemeral probe ではなく durable
  `packages/rag/tests/ingest.spec.ts`（`packages` project=node env）を作成。RED = `@vaz/rag/ingest/index` 未解決
  （`no tests`）→ GREEN = **15 passed**（chunkText 4 / consistency guard 4 / mixing guard 3 / orchestrator 3 = ordinal
  連番・空 chunk skip・provider 混在 reject / FS loader 1 = tmpdir 実読取で `.bin` 除外）。
- **検証**: ingest.spec.ts 15 passed、`mise run test:run` = **10 files / 57 passed**（9/42 → 10/57、回帰なし）、
  isolated tsc（`--ignoreConfig --strict --module esnext --target es2022 --moduleResolution bundler --verbatimModuleSyntax
  --types node`）**exit 0**（ai/drizzle-orm/pg-core/@vaz/config/@vaz/schemas/../db/schema/node 解決、tx・insert・delete 型 OK）、
  `mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 60 files … No fixes applied`
  （初回 import 順 + 100char wrap の 2 file を `lint:fix` で整形＝formatting のみ、logic 不変）。gate typecheck は
  source-only echo marker のため ingest.ts 非被覆 → 最終被覆は 9.5 bin / 9.6 web 配線 + isolated tsc。
- **9.3 完了**: `packages/rag/src/retrieve/index.ts`（新規）に reranker なしのベクトル検索を実装（R2.1/2.7）。
  9.2 と同型に注入シーム上で構成: `retrieve(query, deps)` の `deps`={store(`RetrievalStore` port), embedQuery, topK?, logger?}。
  DB/network なしで全経路をユニット検証可能。
- **[R2.7 reranker なし] 検索経路**: store が SQL で最近傍走査（pgvector `<=>`、index-backed、ORDER BY 距離 LIMIT k）、
  orchestrator は cosine 距離 → `RetrievedChunk.score`（`distanceToScore = 1 - distance`、大きいほど類似, 9.1 契約）へ変換し
  **score DESC で再ソート**（store の順序に非依存で「most-similar-first」契約を保証）。空/空白クエリは embed/search せず `[]`。
- **guard**: query 埋め込み次元 ≠ `EMBEDDING_DIM` は throw（corpus と同一モデルでの埋め込みを強制）、`topK` 非正整数は fail-fast。
  既定 `DEFAULT_TOP_K = 5`。
- **adapters（composition-root 配線, 実 DB 実証は deferred）**: `createDrizzleRetrievalStore(db)`（driver-agnostic
  `PgDatabase<PgQueryResultHKT>`、`cosineDistance(embedding.vector, q).mapWith(Number)` + embedding⋈chunk⋈document の
  innerJoin、9.2 と同じく `pg` 非結合）、`createDefaultQueryEmbedder(env)`（`resolveEmbeddingModel` + `embed`（単一）, lazy）。
  実 pgvector 検索は 10.x recall@k / 9.6 chat で初実証（8.1 image-pull FLAG と同クラス）。
- **TDD（durable test）**: `packages/rag/tests/retrieve.spec.ts`。RED = `@vaz/rag/retrieve/index` 未解決（`no tests`）→
  GREEN = **7 passed**（distanceToScore / 空クエリで no-embed no-search / 距離→score 変換 + 順序保証 + 全件が
  `retrievedChunkSchema` 適合 / topK 既定・override 転送 / query vector 転送 / 次元不一致 throw / 非正 topK throw）。
- **検証**: retrieve.spec.ts 7 passed、`mise run test:run` = **11 files / 64 passed**（10/57 → 11/64、回帰なし）、
  isolated tsc（同上フラグ）**exit 0**（`cosineDistance`/`eq`/join 結果型・`.mapWith(Number)` の distance:number 解決）、
  `mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 62 files … No fixes applied`
  （初回 import 名順の 1 file を `lint:fix` 整形＝formatting のみ、logic 不変）、`--frozen-lockfile` clean（新規依存なし）。
  gate typecheck は source-only echo marker のため retrieve.ts 非被覆 → 最終被覆は 9.4 tool / 9.6 web 配線 + isolated tsc。
- **9.4 完了**: `packages/rag/src/tools.ts`（新規）に `createRetrievalCapability(deps, options?)` を実装（R2.4）。
  `@vaz/tools#createTimeCapability` の capability パターン + `createChatAgent` の seam 慣行に整合: `{ searchDocuments }`
  （`tool()`）を返し、runtime concern は `AgentDeps<RagDatabase>`（ADR-3）経由。`options.store`/`embedQuery` は test seam
  （既定は `deps.db` から `createDrizzleRetrievalStore` + `createDefaultQueryEmbedder`＝production 配線）。
- **[R2.4] tool 出力 = chunks + citations**: `inputSchema = { query: min(1), topK?: int().positive().max(20) }`。execute は
  9.3 `retrieve` を呼び `{ chunks: RetrievedChunk[], citations: Citation[] }` を返す。citations は 9.1 `toCitation` の 1:1 projection
  （chunk→{documentId,source,chunkId}、本文・score 非携行）。これが agent が注入する untrusted コンテキストブロック（R5.2 の
  明示区切り注入は 9.6 の責務、tool 出力は system prompt に非混入）。
- **[設計] topK 優先順位**: per-call `topK`（LLM 指定）→ `options.topK`（construction 既定）→ `DEFAULT_TOP_K`（5）。
- **[privacy] execute は raw query を非ログ**（deps.ts の PRIVACY CONTRACT: INFO 以下で raw prompt/tool IO 非記録）。
  time capability に倣い execute 内ログは持たない（audit/logging は Phase 4/5）。model 文字列非含（`lint:model-ids` ✅）。
- **TDD（durable test）**: `packages/rag/tests/tools.spec.ts`。execute の第 2 引数（`ToolCallOptions`）は execute が不使用のため
  test では input のみで直接呼出（runtime 安全）。RED = `@vaz/rag/tools` 未解決（`no tests`）→ GREEN = **4 passed**
  （searchDocuments 露出 + inputSchema が query 必須 / chunks+citations が 9.1 契約適合・most-similar-first・citation projection /
  空マッチで `{chunks:[],citations:[]}` / per-call topK が construction 既定を上書き）。
- **検証**: tools.spec.ts 4 passed、`mise run test:run` = **12 files / 68 passed**（11/64 → 12/68、回帰なし）、
  isolated tsc（同上フラグ）**exit 0**（`ai` tool / `@vaz/schemas/rag` / `drizzle-orm/pg-core` / `./retrieve/index` 解決）、
  `mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 64 files … No fixes applied`
  （初回 import 順 + tool 定義 wrap の 1 file を `lint:fix` 整形＝formatting のみ、logic 不変）。gate typecheck は source-only
  echo marker のため tools.ts 非被覆 → 最終被覆は 9.6 web 配線（`createChatAgent` が capability 登録）+ isolated tsc。
- **9.5 完了**: `packages/rag/bin/ingest.ts`（新規）に CLI エントリを実装（R2.6）。composition root として
  `Pool`(pg) → `drizzle(pool)` → `createDrizzleIngestStore` + `createDefaultEmbedder` を配線し `ingest(corpusPath, {store, embed, logger})`
  を呼ぶ。8.2 で宣言済の `"ingest": "node bin/ingest.ts"` から `pnpm --filter @vaz/rag ingest <path>` で起動。
- **[testable unit + I/O 分離]** pure 関数を export しユニット検証: `parseIngestArgs(argv)`（第 1 positional=corpus path、
  欠落/空白で usage throw）/ `resolveDatabaseUrl(env)`（`DATABASE_URL` 直読み、空/未設定で fail-fast）/ `createConsoleLogger()`。
  Pool/drizzle/ingest の実配線は I/O 境界（実 DB/Ollama）＝8.1 image-pull FLAG と同じく deferred。
- **[entry guard] `import.meta.main`（Node 24.18 stable）**: `main()` は本 file がプロセスエントリのときのみ実行。test が
  import しても main は走らず DB 接続を開かない（bin は `./src/*` exports 外のため test は相対 `../bin/ingest` で import）。
- **[FLAG→解決] `@vaz/rag` intra-package import を self-referencing 化（Node native ESM 対応, Task 9 境界内）**: CLI を
  実 `node bin/ingest.ts` で走らせると、拡張子なし相対 import（`../db/schema` 等）が Node native ESM で `ERR_MODULE_NOT_FOUND`
  になることが判明（vitest/Turbopack は解決するが Node は拡張子必須）。bin は直接 node 実行される初のエントリのため顕在化。
  **root cause**: repo の intra-package 相対 import は拡張子なし規約。**fix**: ingest chain（`bin`→`ingest/index`→`db/schema`）
  および一貫性のため `retrieve/index`・`tools.ts` の intra-package import を `@vaz/rag/*`（exports map が `.ts` を付与＝Node 解決可能、
  AGENTS.md「import by path」に整合、test が既に使う specifier）へ変更。tsc(bundler)/vitest/Turbopack でも同一解決。実測: `node
  packages/rag/bin/ingest.ts` は no-args→usage エラー / path のみ→`DATABASE_URL` エラーで **exit 1**（module chain 完全解決、
  I/O 手前まで到達）。**申し送り**: `@vaz/rag` 以外の package を将来 node 直実行する際は同様に self-referencing 化が必要。
- **TDD（durable test）**: `packages/rag/tests/ingest-cli.spec.ts`。RED = `../bin/ingest` 未実装（`no tests`）→ GREEN =
  **8 passed**（parseIngestArgs 4: path 取得・余剰無視・欠落 throw・空白 throw / resolveDatabaseUrl 3: 取得・未設定 throw・空白 throw /
  createConsoleLogger 1: 4 レベル関数）。
- **検証**: ingest-cli.spec.ts 8 passed、`mise run test:run` = **13 files / 76 passed**（12/68 → 13/76、回帰なし ―― self-ref 化後も
  9.1–9.4 全緑）、isolated tsc（rag src 4 file + bin、同上フラグ）**exit 0**（`drizzle(pool)`=NodePgDatabase → `createDrizzleIngestStore`
  の `PgDatabase<PgQueryResultHKT>` へ代入可＝HKT variance OK、`import.meta.main`/`pg`/self-ref specifier 解決）、`mise run typecheck`
  exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 66 files … No fixes applied`（import 順の複数 file を `lint:fix`＝
  formatting のみ、logic 不変）、`--frozen-lockfile` clean、**実 CLI 起動**で module 解決 + 引数/env バリデーション到達（exit 1）。
- **[deferred] 実 corpus 取り込み**（実 Postgres+pgvector への upsert / Ollama 埋め込み）は 8.1 image-pull ブロックで本セッション未実証 →
  到達可能環境で `DATABASE_URL` + Ollama 起動下に `pnpm --filter @vaz/rag ingest ./docs` を実行して実証（10.x recall@k もこの corpus を利用）。
- **9.6 完了**: `packages/agents/src/chat-agent.ts` を Modify し RAG retrieval capability をツール登録（R2.4）。
  純関数 `buildChatTools(deps, options)` を新設・export（登録判定を stream なしでユニット検証可能）。`getCurrentTime` は常時、
  `searchDocuments`（9.4）は retrieval available 時のみ登録。`createChatAgent` は `buildChatTools` を用い、`options.retrieval`
  seam（`model` seam と同型の test seam / 明示 override）を追加。
- **[R1.7 後方互換 = deps 駆動の db ゲート]**: `searchDocuments` は「retrieval 注入 or `deps.db != null`」のときのみ登録。
  Phase 1（route/test とも `db: null`）は time ツールのみ＝Phase 1 と完全同一挙動（既存 chat-agent.spec.ts 2 tests 不変で緑）。
  Phase 2 で route が Drizzle client を deps.db に渡すと自動で RAG 有効化。`deps as AgentDeps<RagDatabase>` は ADR-3
  「Phase 2 consumers narrow」の composition-boundary アサーション。
- **[R5.2/R2.4] 引用注入**: retrieval 結果は tool result（`{chunks, citations}`）として返る＝system prompt 非混入の明示区切りブロック
  （R5.2 充足）。tool description が「回答に引用を明示」を指示。citations は 9.1 `toCitation` の 1:1 projection。prompt 構築の精緻化は 19.1（Phase 5）。
- **[dep グラフ] `@vaz/agents` → `@vaz/rag`**: `agents/package.json` に `@vaz/rag: workspace:*` を追加（graph: schemas → config/tools/rag →
  agents → web に整合、8.3/9.2 の package.json 境界拡張前例）。workspace link のみ（download 0）。
- **[根本原因→修正] ToolSet union 型エラー（apps/web tsc が初検出）**: 当初 `buildChatTools` は `{time} | {time,search}` の union を返し、
  `apps/web` の実 tsc（本チェーンを初めて型検査）が `ToolSet`（=`Record<string, Tool&...>`）非適合を検出（union の `searchDocuments` が
  `Tool | undefined` に評価され index signature 不適合）。**fix**: 単一 `ToolSet` record を構築し retrieval available 時のみ
  `searchDocuments` を代入。**学び**: 9.6 で apps/web tsc が rag チェーンを初めて実型検査＝source-only echo marker では拾えない型不整合の最終防波堤。
- **TDD（durable test）**: `packages/agents/tests/chat-agent-rag.spec.ts`。RED = `buildChatTools`/`retrieval` seam 未実装（4 failed）→
  GREEN = **4 passed**（db:null → time のみ / db present → searchDocuments 登録（deps 駆動）/ retrieval 注入で登録 / mock model が
  searchDocuments を呼ぶと capability 実行され `{chunks, citations}`（1:1、9.1 契約）を返す）。既存 chat-agent.spec.ts 2 tests も緑（R1.7）。
- **検証**: chat-agent-rag.spec.ts 4 passed、`mise run test:run` = **14 files / 80 passed**（13/76 → 14/80、回帰なし）、
  **`mise run typecheck` exit 0（apps/web tsc が agents→rag→retrieve→schema チェーンを実型検査＝rag src の初 gate 被覆）**、
  `mise run lint:model-ids` ✅、`mise run lint` = `Checked 67 files … No fixes applied`（整形不要）、`--frozen-lockfile` = `Already up to date`、
  `mise run audit` = No known vulnerabilities。

**Task 9（RAG ingest / retrieve capability）完了**: 9.1–9.6 全緑（Phase 2 の RAG capability を確立）。`RetrievedChunk`/`Citation` 契約(9.1) +
ingest 経路（loader→chunk→embed→upsert + provider/dim guard, 9.2）+ retrieve（reranker なし pgvector, 9.3）+ `createRetrievalCapability`
tool（chunks+citations, 9.4）+ ingest CLI（9.5）+ chat-agent 登録（deps 駆動・R1.7 後方互換, 9.6）。新規依存: `pg`/`@types/pg`（9.2）+
`@vaz/rag` workspace edge（9.6）。**FLAG（未解決）**: 実 Postgres+pgvector / Ollama への end-to-end（ingest 実行・retrieve 検索）は
8.1 image-pull ブロックで本セッション未実証 → 到達可能環境で実証（10.x recall@k が実証点）。**次は Task 10（recall@k ゴールデンセット評価）**。

---

## 10. RAG `recall@k` ゴールデンセット評価（Phase 2）

20–50 件の質問→期待 docID のゴールデンセットを用意し、埋め込みのみ（LLM 非依存）の
`recall@k` テストを CI で走らせる。

_Boundary:_ `packages/rag/tests/fixtures/golden-set.json`, `packages/rag/tests/recall.spec.ts`
_Depends:_ 9
_Requirements:_ 2.5

- [x] 10.1 `tests/fixtures/golden-set.json` に 20–50 件の質問→期待 document-ID ペアを作成する。
  _Boundary:_ `packages/rag/tests/fixtures/golden-set.json`
  _Depends:_ 9.2
  _Requirements:_ 2.5
- [x] 10.2 `tests/recall.spec.ts` に `recall@k` テストを実装する（埋め込みのみ、CI で実行）。
  _Boundary:_ `packages/rag/tests/recall.spec.ts`
  _Depends:_ 10.1, 9.3
  _Requirements:_ 2.5

### Implementation Notes

- **10.1 完了**: `packages/rag/tests/fixtures/golden-set.json`（新規）に recall@k ゴールデンセットを作成（R2.5）。
  **14 docs の corpus + 30 questions**（20–50 の範囲内）を単一ファイルに同梱した **self-contained 設計**。
- **[設計判断] なぜ corpus 同梱か**: `document.id` は `uuid().defaultRandom()`（8.3 schema）で ingest 時ランダム採番のため、
  外部 corpus を参照する golden set は CI で docID が非決定的になる。10.1 の編集境界は `golden-set.json` **1 ファイルのみ**で、
  安定 docID を固定できる唯一の場所がこのファイル。よって corpus（各 doc に**安定 UUID `id`** + `source` + `content`）と
  questions（`expectedDocumentIds`）を同梱し、埋め込みのみ・LLM 非依存・CI 決定的な recall@k を成立させた。
  `id` は valid UUID＝`retrievedChunkSchema.documentId`（`z.uuid()`, 9.1）と `rag.ts:22`「score recall@k by document ID」に整合。
- **[10.2 への配線契約]**: 10.2（`recall.spec.ts`）は本 fixture の corpus を各 doc の**明示 `id`** で store へ seed
  （`ingest()` は random id を強制するため insert seam を用いる想定）→ chunk/question を configured embedding model で埋め込み
  （embeddings only, no LLM）→ `retrieve`（9.3）→ 返却 `documentId` を `expectedDocumentIds` と突合して recall@k を算出。
  トップレベル `k`（=5, `DEFAULT_TOP_K` に整合）と `description` に消費手順を明記。
- **corpus トピック**: 実プロジェクトの知識（VAZ stack / monorepo / request flow / provider resolution / DI / model-id gate /
  AI SDK v7 / testing / telemetry / Carbon / RAG ingest / retrieve / schema / chat-agent RAG tool）を各 doc 1 トピックで
  弁別可能に構成。question の大半は単一 doc 期待、q29/q30 は 2 doc 期待（ingest⋈schema, chat-agent⋈retrieve）で多重被覆も表現。
- **[R1.8] model-id 非該当**: fixture は model ID リテラル（`claude-`/`llama` 等）を含まず（`nomic embedding model` は自然文表現）、
  `lint:model-ids` ✅（gate は `.ts/.tsx` のみ走査だが JSON も clean）。
- **TDD（recall@k = post-impl 検証, tasks.md L16–17 の除外規定）**: recall@k fixture は RED-GREEN 対象外。代わりに **ephemeral
  node バリデータ**で不変条件を実証: JSON well-formed / 全 docID・expectedID が valid UUID / expectedID が corpus doc に解決 /
  id・question id に重複なし / question 数 30（20–50 内）/ k≥1 → **OK**（検証後スクリプトは残さず）。
- **検証**: ephemeral validator OK（14 docs / 30 questions / all IDs resolve / no dupes）、`mise run lint` = Checked **68 files** /
  No fixes applied（JSON も biome tab 整形準拠）、`mise run lint:model-ids` ✅、`mise run typecheck` exit 0（fixture は JSON ＝
  非型検査、回帰なし）、`mise run test:run` = **14 files / 80 passed**（Task 9 から回帰なし ―― 10.2 未実装のため fixture は
  まだ消費されず）。実 embedding/pgvector 経路での recall@k 実証は 10.2 + 到達可能環境（8.1 image-pull FLAG 解消後）。
- **10.2 完了 / [解決] Task 10 FLAG（実 embedding 経路の recall@k 実証）**: `packages/rag/tests/recall.spec.ts` を
  **2 層**で新設。(1) 常時実行の決定論層 ―― `recallForQuestion`/`distinctDocIds`（純関数の recall@k 採点、full/partial/miss/
  空 expected を assert）+ golden-set fixture 契約（k≥1・20–50 questions・docID 一意 UUID・全 expectedID が corpus に解決）。
  ネットワーク非依存で CI で常に緑。(2) gated 統合層 ―― configured embedder で corpus/question を埋め込み（**埋め込みのみ・
  LLM 非依存**、R2.5）→ in-memory cosine-NN store（pgvector `<=>` と同一の `1 − cosθ` 距離）へ **各 doc の明示 `id`** で seed
  （ingest の random-id を迂回、10.1 配線契約）→ `retrieve`（9.3, topK=k）→ 返却 documentId を expectedDocumentIds と突合し
  mean recall@k を算出。
- **[設計] DB-free 統合 + honest auto-skip**: 実 DB（Postgres/pgvector）は持ち込まず、cosine 距離を JS で再現した in-memory
  store で `retrieve` を駆動（`@vaz/rag` unit suite の DB-free 規律を維持、測定対象＝configured embedding の corpus 弁別能は
  DB 版と同一）。統合テストは **embedding model 到達性で auto-skip**（Ollama `/models` に解決モデル ID があるかを 2s probe、
  chat E2E と同一の honest-skip）→ model 未 pull の CI では skip、到達可能環境では実行。model ID は `@vaz/config/embedding` の
  `DEFAULT_EMBEDDING_MODEL_ID` から取得（直書きなし。加えて test は forbid-model-ids gate の carve-out）。
- **[FLAG 解消（実測）]**: `nomic-embed-text`（768-dim, EMBEDDING_DIM）を pull した到達可能環境で統合層を実行 →
  **mean recall@5 = 1.000 / 30 questions（全問 perfect）**。閾値 `MIN_MEAN_RECALL = 0.8` を大きく上回り、Task 8/9 から
  継続していた「実 embedding 経路の recall@k 未実証」FLAG を解消。q29/q30（2 doc 期待の多重被覆）も含め全問 recall=1.0。
- **TDD（recall@k = post-impl 検証, tasks.md L16–17 除外規定）**: recall metric は RED-GREEN 対象外。代わりに決定論層が
  採点ロジックの非空虚性を CI で常時 assert（メトリック実装が壊れれば full/partial/miss ケースで即赤化）、統合層が実
  embedding での end-to-end を実証。
- **検証**: `mise run test:run` = **15 files / 87 passed**（14/80 → +1 file/+7 tests、回帰なし。統合層は Ollama 到達環境で実行、
  非到達 CI では skip）、`mise run typecheck` exit 0（`apps/web tsc` が agents→rag→retrieve/ingest/schema を実型検査）、
  `mise run lint` = Checked **69 files** / No fixes applied（biome tab/format 準拠、初版の折返しは lint:fix で決定論的整形）、
  `mise run lint:model-ids` ✅（test carve-out + config 委譲で直書きなし）。

**Task 10（RAG `recall@k` ゴールデンセット評価）完了**: 10.1–10.2 全緑。self-contained golden set（14 docs / 30 questions,
R2.5）+ 2 層 recall.spec（決定論採点 常時 + 実 embedding gated 統合）を確立。到達可能環境で **mean recall@5 = 1.000** を実測し
Task 8/9 から継続の実 embedding-path FLAG を解消。Phase 2 の RAG 評価点が確立 → 次は **Phase 3（Task 11: 耐久エンジンスパイク）**。

---

## 10R. アドバーサリアルレビュー由来ハードニング（Phase 2 remediation）

Task 8–10 完了後の `/code-review`（high）+ `/adversarial-review` で検出した Phase 2 の不変条件
ギャップを是正する。#7/#1 は本 remediation で対応済み。#3/#4/#5 は実 DB / migration ツール
（drizzle-kit）を前提とするため Task 8.1（pgvector image-pull）FLAG 解消後に着手する。

_Boundary:_ `packages/agents/src/chat-agent.ts`, `packages/rag/src/db/schema.ts`, `packages/rag/src/ingest/index.ts`, `packages/rag/src/retrieve/index.ts`, `packages/rag/src/tools.ts`, `apps/web/src/app/api/chat/route.ts`
_Depends:_ 9, 10
_Requirements:_ 2.2, 2.3, 2.4, 1.7

- [x] 10R.1 (#7) `buildChatTools` の RAG 登録述語を `db != null` から Drizzle クライアント
  duck-type（`select` 関数）へ厳格化し、無検査キャストを除去する。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 9.6
  _Requirements:_ 2.4, 1.7
- [x] 10R.2 (#1) 埋め込み provenance を provider+dim → **provider+model+dim** に拡張し、同一次元・
  同一 provider のモデル取り違え（無言のベクトル空間混在）を ingest ガード（`assertNoProviderMixing`）と
  retrieve 読み取り側ガード（`queryProvenance`）の双方で拒否する。`embedding.model` 列 /
  `EmbeddingProfile.model` / `EmbedBatch`・`DocumentUpsert` の model 伝播を追加。
  _Boundary:_ `packages/rag/src/db/schema.ts`, `packages/rag/src/ingest/index.ts`, `packages/rag/src/retrieve/index.ts`, `packages/rag/src/tools.ts`
  _Depends:_ 9.2, 9.3
  _Requirements:_ 2.2, 2.3
- [ ] 10R.3 (#5) `document.source` に UNIQUE 制約を付与し、冪等再取り込みを DB 制約 + ON CONFLICT で
  裏付ける（並行 ingest / 重複 source loader での document 重複防止）。**[8.1 FLAG]** drizzle-kit 導入 + 実 DB 必須。
  _Boundary:_ `packages/rag/src/db/schema.ts`, `packages/rag/src/ingest/index.ts`
  _Depends:_ 8.1, 10R.2
  _Requirements:_ 2.2
- [ ] 10R.4 (#4) `getEmbeddingProfile` を `LIMIT 1` → `SELECT DISTINCT provider,model,dim`（>1 で throw）に
  変更し、混在ガードの baseline を「標本」から「不変条件」にする。**[8.1 FLAG]** 実 DB 必須。
  _Boundary:_ `packages/rag/src/ingest/index.ts`, `packages/rag/src/retrieve/index.ts`
  _Depends:_ 8.1, 10R.2
  _Requirements:_ 2.2, 2.3
- [ ] 10R.5 (#3) `apps/web` chat route に `DATABASE_URL` 有無で Drizzle クライアントを配線し、本番経路で
  `searchDocuments` を活性化する（R2.4 end-to-end）。**[8.1 FLAG]** 実 DB + Ollama 埋め込み（E2E は Playwright）必須。
  _Boundary:_ `apps/web/src/app/api/chat/route.ts`
  _Depends:_ 8.1, 9.6
  _Requirements:_ 2.4

### Implementation Notes

- **10R.1 完了 (#7)**: `isRagDatabase(db)`（`select` 関数の duck-type）で narrow し、Drizzle 互換
  クライアントのときのみ RAG を登録。narrow 後の `{ ...deps, db }` で `AgentDeps<RagDatabase>` を構成し、
  旧 `deps as AgentDeps<RagDatabase>` 無検査キャストを除去。TDD: 非 Drizzle truthy db → `getCurrentTime`
  のみ（RED→GREEN）。既存「datastore あり」テストは `db:{select(){}}` に更新。
- **10R.2 完了 (#1)**: `embedding.model text notNull` 追加、`EmbeddingProfile`/`EmbedBatch`/`DocumentUpsert`
  へ model 伝播、`createEmbedder` は `model.modelId` を記録。`assertNoProviderMixing` は provider+model+dim
  照合。retrieve 側は `RetrievalStore.getEmbeddingProfile?()`（optional=後方互換）+ `RetrieveDeps.queryProvenance?`
  を追加し、corpus provenance と query の provider/model 不一致で throw。`tools.ts` は default embedder 使用時のみ
  env から `queryProvenance` を lazy 解決（#6 の遅延性を維持、注入 embedQuery のテストでは guard no-op）。TDD:
  同一 provider/dim・別 model → ingest/retrieve 双方で throw（RED→GREEN）。
- **検証**: `pnpm exec vitest run` = 15 files / **93 passed**（89→93、回帰なし）、`mise run typecheck` = apps/web
  tsc **Done**（`@vaz/rag`/`@vaz/agents` を transitive 型検査、`model.modelId` 含む型伝播 OK）、`mise run lint` =
  Checked 69 / No fixes、`mise run lint:model-ids` ✅。
- **[8.1 FLAG] 10R.3/4/5・10R.2 DDL の deferral 根拠**: 本環境は (a) pgvector image-pull 不可（Task 8.1 FLAG）、
  (b) Ollama 到達不可（recall 統合は honest-skip）、(c) migration ツール未導入（drizzle-kit 不在＝`embedding.model` /
  `unique(source)` の DDL 適用手段が無い）。10R.3（UNIQUE）/10R.4（DISTINCT）/10R.5（route→DB）は実 DB + drizzle-kit
  導入（esbuild postinstall の allowBuilds 監査を伴う）前提のため 8.1 後に着手。10R.2 の `embedding.model` 列 DDL 適用も
  8.1 後（現状 Drizzle スキーマ定義 + guard ロジックのみ＝8.3/9.2 と同一の source-only 検証規律）。

---

## 11. (P) 耐久エンジンスパイクとワークフロー契約（Phase 3）

Inngest vs Temporal (TS SDK) をスパイクで比較確定し、supervisor→specialist の型付き
step I/O と `JobEvent` 判別共用体を `packages/schemas` に定義する。

_Boundary:_ `docs/spikes/phase3-durable-engine.md`, `packages/schemas/src/workflows.ts`
_Depends:_ 7
_Requirements:_ 3.2, 3.3, 3.6

- [x] 11.1 `docs/spikes/phase3-durable-engine.md` に Inngest と Temporal (TS SDK) の
  実装比較（中断/再開・HITL・再起動跨ぎ）とエンジン確定結論を記録する。
  _Boundary:_ `docs/spikes/phase3-durable-engine.md`
  _Depends:_ 7
  _Requirements:_ 3.2
- [x] 11.2 `packages/schemas/src/workflows.ts` に supervisor→specialist の step I/O
  Zod スキーマと `JobEvent` 判別共用体（step-start/tool-call/token/completion/error）を定義する。
  _Boundary:_ `packages/schemas/src/workflows.ts`
  _Depends:_ 7
  _Requirements:_ 3.3, 3.6

### Implementation Notes

---

## 12. supervisor と承認ポリシー（`@vaz/agents` / Phase 3）

<!-- 12.1 完了 (2026-07-06): packages/agents/src/supervisor.ts に createSupervisorWorkflow(deps) を実装。
     dispatch(plan, {jobId}) が SupervisorPlan の各 step を kind で specialist へ分配し、typed result を
     stepId で相関回収。rag-research→document-generation の citation ハンドオフ、JobEvent 判別共用体
     (step-start/completion/error) の emit を実装。エンジン非依存: WorkflowStepRunner ポート seam で
     durability を注入（default=in-process、Task 13 で Inngest step.run をラップ）—Inngest を import しない。
     ts は deps.now().toISOString()（ADR-3）。default specialists: rag-research=RAG capability 実結線（決定的）、
     document-generation=model seam(generateText, 遅延 resolveModel)、data-processing=app 定義のため未登録時 throw。
     seam: options.{specialists,step,emit,retrieval,model}。tests: supervisor.spec.ts 10 件（network/LLM/engine-free）。-->
<!-- 12.2 完了 (2026-07-07): packages/agents/src/approval-policy.ts に createToolApprovalPolicy(options) を実装。
     AI SDK v7 の toolApproval コールバック互換の関数を返し、破壊的ツール呼び出しに 'user-approval'（＝中断/HITL、
     Inngest step.waitForEvent へ Task 13/14 で接続）、それ以外に 'not-applicable' を返す。破壊性判定は加算的:
     ①isDestructive フック（R5.3 escalation の口、加算的で needsApproval を抑制しない）②destructiveTools 名集合
     ③tool の needsApproval 宣言（true or 述語関数を評価）。needsApproval は AI SDK で deprecated（toolApproval へ移行）
     のため、tool 側は「破壊性マーカー」として宣言・enforcement は本ポリシー＝現行機構、で整合。未知ツールは既定 not-applicable。
     ApprovalToolCall を TypedToolCall の構造的部分集合にし streamText({toolApproval}) へ代入可能。
     tests: approval-policy.spec.ts 7 件（pure/network-free）。-->
<!-- 12.3 完了 (2026-07-07): packages/tools/src/email.ts に createEmailCapability(deps,{transport?}) を実装。
     sendEmail = tool({ description, inputSchema=sendEmailInputSchema(to=z.email/subject/body), needsApproval: true, execute })。
     needsApproval:true が 12.2 policy の破壊性マーカー → 'user-approval'（宣言→判定→中断の結線を実証）。
     ADR-3: sentAt は deps.now()、配信は EmailTransport seam（既定=ネットワークなしスタブ、messageId は clock 由来で決定的）。
     R4.7 privacy: info では messageId のみログ（subject/body=生入力は非記録）。allowlist(R5.4) は 19.3、承認 UI/再開は 14.x。
     @vaz/tools/index に再エクスポート。tests: email.spec.ts 7 件（network-free）。→ セクション 12 完了。-->


supervisor による専門エージェントへの型付きディスパッチと、破壊的ツールを
`user-approval` 化する `toolApproval` ポリシーを実装する。

_Boundary:_ `packages/agents/src/supervisor.ts`, `packages/agents/src/approval-policy.ts`, `packages/tools/src/email.ts`
_Depends:_ 11
_Requirements:_ 3.3, 3.4

- [x] 12.1 `src/supervisor.ts` に `createSupervisorWorkflow(deps)` を実装し、計画→
  専門エージェント（RAG research / document generation / data processing）へ workflow step として分配する。
  _Boundary:_ `packages/agents/src/supervisor.ts`
  _Depends:_ 11.2
  _Requirements:_ 3.3
- [x] 12.2 `src/approval-policy.ts` に `toolApproval` ポリシーを実装し、破壊的ツール
  （`needsApproval`）でワークフローを中断させる。
  _Boundary:_ `packages/agents/src/approval-policy.ts`
  _Depends:_ 11.2
  _Requirements:_ 3.4
- [x] 12.3 `packages/tools/src/email.ts` に代表的な破壊的ツール（外部送信）を
  `tool({ description, inputSchema, execute, needsApproval })` として実装し、承認フロー
  （12.2 のポリシー中断 → 14.x の承認 UI → 再開）を実証可能にする。
  _Boundary:_ `packages/tools/src/email.ts`
  _Depends:_ 4.3
  _Requirements:_ 3.4

### Implementation Notes

---

## 13. `apps/worker` 長時間実行ワーカーと耐久実行（Phase 3）

Node 24 常駐プロセスとして耐久ワークフローを実行し、進捗イベント永続化・監査 sink・
コンテナ化・再起動跨ぎ完走を成立させる。

_Boundary:_ `apps/worker/package.json`, `apps/worker/src/main.ts`, `apps/worker/src/events.ts`, `apps/worker/src/audit.ts`, `apps/worker/src/stores.ts`, `apps/worker/src/publisher.ts`, `apps/worker/src/inngest.ts`, `apps/worker/src/start.ts`, `apps/worker/Dockerfile`, `docker-compose.yml`, `packages/rag/src/db/schema.ts`, `pnpm-workspace.yaml`
_Depends:_ 12, 9, 11, 8
_Requirements:_ 3.1, 3.2, 3.5, 3.6, 3.7, 4.2, 5.5

- [x] 13.1 `apps/worker/package.json` を作成し `@vaz/worker`（`@vaz/agents`/`@vaz/rag` 依存、Node 24 常駐）として定義する。
  _Boundary:_ `apps/worker/package.json`
  _Depends:_ 12.1
  _Requirements:_ 3.1
- [x] 13.2 `src/main.ts` にエンジンのワーカーエントリと step 実行を実装し、ジョブ投入
  （web）と実行（worker）を分離する。span に `jobId`/`userId`/agent 名を付与する。
  _Boundary:_ `apps/worker/src/main.ts`
  _Depends:_ 13.1, 11.2, 9.4
  _Requirements:_ 3.1, 3.2, 4.2
- [x] 13.3 `src/events.ts` に進捗イベント永続化（DB/Redis pub/sub）を実装する。
  _Boundary:_ `apps/worker/src/events.ts`
  _Depends:_ 13.1, 11.2
  _Requirements:_ 3.6
- [x] 13.4 `src/audit.ts` に worker 経路の `deps.audit` DB sink 実装を供給する（発火点は `@vaz/agents`）。
  _Boundary:_ `apps/worker/src/audit.ts`
  _Depends:_ 13.1
  _Requirements:_ 5.5
- [x] 13.5 `Dockerfile`（`pnpm deploy`）を作成し、`docker-compose.yml` に worker/engine/redis サービスを追加する。
  _Boundary:_ `apps/worker/Dockerfile`, `docker-compose.yml`
  _Depends:_ 13.2
  _Requirements:_ 3.1
- [x] 13.6 チェックポイントによる中断→再開と worker 再起動跨ぎ完走（10 分超ジョブ）を実装する。
  _Boundary:_ `apps/worker/src/main.ts`
  _Depends:_ 13.2
  _Requirements:_ 3.5, 3.7

<!-- 13.7–13.9 は /sdd-validate-impl (2026-07-08) が検出した2つの機能ギャップへの対応として追加。
     13.1–13.6 は 8.1 FLAG 下で seam/port/配線に限定して完了済み（engine-agnostic）。以下は
     Phase 3 を実稼働（Task 14/15）させる前に必要な「具体実装（DB schema・実 store・engine bootstrap）」。 -->

- [x] 13.7 `Job`/`JobEvent`/`AuditLog` の Drizzle テーブルを定義する（11.2 の `JobEvent` 契約と
  `AuditEntry`(deps.ts) を DB 化。`Job` は jobId/userId/status/createdAt、`JobEvent` は 11.2 判別共用体を
  列挙 type + jsonb payload で、`AuditLog` は id/jobId(fk,nullable)/userId/tool/args(jsonb)/ts。plan.md データモデル準拠）。
  drizzle-zod で @vaz/schemas 契約と整合させる。
  _Boundary:_ `packages/rag/src/db/schema.ts`
  _Depends:_ 8.3, 11.2
  _Requirements:_ 3.6, 5.5
  <!-- 設計注記: DB infra(drizzle+pg)の home は現状 @vaz/rag のみ。ドメイン的には worker/security だが、
       専用 @vaz/db 分離は Phase 3 スコープ外の refactor のため 8.3 の schema.ts を拡張する。 -->
- [x] 13.8 `events.ts`/`audit.ts` の port に対する**実 store 実装**を供給する:
  Postgres `JobEventStore.append` / `AuditLogStore.insert`（Drizzle insert、13.7 テーブル）と Redis
  `JobEventPublisher.publish`（pub/sub fan-out）。redis クライアント依存を追加し `allowBuilds` を監査する。
  _Boundary:_ `apps/worker/src/stores.ts`, `apps/worker/src/publisher.ts`, `apps/worker/package.json`, `pnpm-workspace.yaml`
  _Depends:_ 13.3, 13.4, 13.7
  _Requirements:_ 3.6, 5.5
- [x] 13.9 `inngest` 依存を追加し、具体 engine bootstrap を実装する: `new Inngest(...)`（`EventSchemas.fromZod`
  で 11.2 契約を型注入）を `DurableEngine` として構築、Inngest `step.waitForEvent` を `ApprovalGate` に写像、
  `registerWorker(engine, buildWorkerDeps({db, audit}), {emit: createJobEventSink(...)})` + Connect 常駐。
  Dockerfile CMD を常駐エントリへ更新する。`allowBuilds` を監査。
  _Boundary:_ `apps/worker/src/inngest.ts`, `apps/worker/src/start.ts`, `apps/worker/package.json`, `pnpm-workspace.yaml`, `apps/worker/Dockerfile`
  _Depends:_ 13.6, 13.8
  _Requirements:_ 3.1, 3.2, 3.5

### Implementation Notes

---

## 14. Web ジョブ API・SSE・承認 UI（Phase 3）

ジョブ投入・SSE 進捗配信・承認イベント受信の Route Handler と、`useJobStream` フック・
承認 UI を実装する。

_Boundary:_ `apps/web/src/app/api/jobs/route.ts`, `apps/web/src/app/api/jobs/[id]/stream/route.ts`, `apps/web/src/app/api/jobs/[id]/approve/route.ts`, `apps/web/src/features/jobs/useJobStream.ts`, `apps/web/src/features/jobs/ApprovalPanel.tsx`
_Depends:_ 13
_Requirements:_ 3.2, 3.4, 3.5, 3.6

- [x] 14.1 `api/jobs/route.ts` に `POST /api/jobs`（workflow 種別 + 入力を Zod 検証 → engine 投入、`{ jobId }` を返す）を実装する。
  _Boundary:_ `apps/web/src/app/api/jobs/route.ts`
  _Depends:_ 11.2, 13.2
  _Requirements:_ 3.2
- [x] 14.2 `api/jobs/[id]/stream/route.ts` に SSE Route Handler を実装し `JobEvent` 判別共用体を配信する。
  _Boundary:_ `apps/web/src/app/api/jobs/[id]/stream/route.ts`
  _Depends:_ 11.2, 13.3
  _Requirements:_ 3.6
- [x] 14.3 `api/jobs/[id]/approve/route.ts` に承認イベント受信（`{ toolCallId, decision, args? }`）→中断中ワークフローへの再開シグナルを実装する。
  _Boundary:_ `apps/web/src/app/api/jobs/[id]/approve/route.ts`
  _Depends:_ 11.2
  _Requirements:_ 3.4, 3.5
- [x] 14.4 `features/jobs/useJobStream.ts` に SSE 消費フックを実装する。
  _Boundary:_ `apps/web/src/features/jobs/useJobStream.ts`
  _Depends:_ 14.2
  _Requirements:_ 3.6
- [x] 14.5 `features/jobs/ApprovalPanel.tsx` に承認 UI（approve/reject/edit args、`"use client"`）を実装する。
  _Boundary:_ `apps/web/src/features/jobs/ApprovalPanel.tsx`
  _Depends:_ 14.3
  _Requirements:_ 3.4

### Implementation Notes

- **14.1 完了**: `apps/web/src/app/api/jobs/route.ts` に `POST /api/jobs` を新設。責務は
  chat route(6.3)と同型の薄い HTTP⇔engine アダプタ ―― `supervisorPlanSchema`(`@vaz/schemas/workflows`,
  11.2)で body を検証 → `jobId`(`randomUUID()`)を生成 → `JobRequest{jobId,userId:null,plan}` を
  組み立て → `submitJob(engine, request)`(13.2 `apps/worker/src/main.ts`)で durable engine へ投入 →
  `{ jobId }` を返す。`userId` は Phase 5 認証(18.2)まで null(R3.2 の decoupling は identity 不要)。
  成功時ステータスは **202 Accepted**(job は durably enqueue 済みで未実行 ―― R3.2 の web/worker 分離を
  ステータスコードで表現、実行進捗は 14.2 SSE で配信)。
- **[設計] engine 取得は `@vaz/worker` を再利用(do.md 13.9 の申し送りに従う)**: `createInngestEngine()`
  (`apps/worker/src/inngest.ts`, 13.9)を呼び同型の Inngest client を構築、`submitJob`/`JobRequest`/
  `DurableEngine`(`apps/worker/src/main.ts`, 13.2)は main.ts の doc コメントが既に「Task 14.1 が
  呼ぶ」と明記していた契約。新規 engine 抽象や `packages/workflows` パッケージは作らず、既存の
  engine-agnostic port(`DurableEngine`)をそのまま境界超えで再利用(ADR-2 に忠実 ―― web も Inngest SDK を
  直接 import しない)。
- **[解決] 単一編集境界 × 新規依存(2.1/3.1/…/6.1 の discipline を継承)**: 14.1 の宣言境界は
  `route.ts` のみだが、`@vaz/worker`(workspace)への依存が新規に必要 ―― `apps/web/package.json` へ
  境界拡張して `"@vaz/worker": "workspace:*"` を追加(3.4/6.4 と同型の解決)。`apps/worker` 自体は
  `exports` map 非宣言(app であり `packages/*` の source-only wildcard 規約対象外)だが、
  `moduleResolution:"bundler"` 配下で拡張子なし subpath(`@vaz/worker/src/{inngest,main}`)は legacy
  file 解決で到達可能 ―― pnpm install 後 `--frozen-lockfile` clean(churn は importer 追加のみ)。
  `inngest` SDK 自体は直接依存に追加せず(main.ts が型のみ・inngest.ts が dynamic import ―— apps/worker
  の node_modules から transitive に型解決、5.1 以来の「direct-deps-only」方針を維持)。
- **[解決] Inngest 実クライアント × 構造的 `DurableEngine` port の型不一致**: `createInngestEngine()` の
  戻り値 `Inngest.Any` は `createFunction` の overload 形が `DurableEngine.createFunction` と構造的に
  一致せず `tsc` が拒否(`trigger`/`handler` 引数形の不一致)。`apps/worker/src/inngest.ts` が
  `InngestFunction.Like` へ cast する前例(edge glue)に倣い、route.ts でも唯一の engine 境界点で
  `as unknown as DurableEngine` を明示 cast(型安全性は `submitJob` 内部の `engine.send` 呼出しが
  Inngest 実装の `send(payload)` と一致することで担保 ―— 構造的に安全)。
- **[非スコープ → 未タスク化(do.md 13.9 の申し送りを継承)]** `Job` 行(13.7 テーブル)の INSERT(status=
  "pending" 等)は 14.1 では行わない ―― store 実装(`stores.ts`, 13.8)は `JobEventStore`/`AuditLogStore`
  のみで `JobStore` 未実装であり、schema/stores は Task 13 の凍結境界。ジョブ行生成 + status 遷移の
  書込点は依然「未タスク化」(do.md 13.9 申し送り(b))―― Phase 3 実運用または後続タスクで確定。
- **TDD(RED-GREEN)**: `apps/web/tests/jobs-route.spec.ts`(chat-route.spec.ts と同型)を先行作成し
  RED(`route.ts` 不在 → import 解決失敗、`Failed to resolve import`)→ 実装 → GREEN(4 tests)。
  `@vaz/worker/src/{inngest,main}` を `vi.mock` して engine/`submitJob` を差し替え ―— 実 Inngest SDK・
  ネットワーク非依存(chat route の precedent と同じ isolation)。ケース: (a) 正常系 = 検証済み plan を
  engine へ送信し生成 `jobId`(UUID 形式)を 202 で返す、(b) 不正 JSON → 400・engine 未呼出、
  (c) スキーマ検証失敗(空 `steps`)→ 400・engine 未呼出、(d) `submitJob` 失敗 → 500(unhandled throw では
  ない)。
- **検証**: `mise run typecheck` exit 0(`apps/web typecheck: Done` ―— `@vaz/worker/src/{inngest,main}`
  含む全鎖を実 tsc で検査)、`mise run test:run` **216 passed**(212→+4、回帰なし)、`mise run lint`
  `Checked 98 files … No fixes applied.`(biome organizeImports 順に整形)、`mise run lint:model-ids`
  ✅、`mise run audit` clean、`pnpm install --frozen-lockfile` Already up to date。
- **次**: Task 14.2（`api/jobs/[id]/stream/route.ts` ―― SSE Route Handler、`JobEvent` 判別共用体配信）。
- **14.2 完了**: `apps/web/src/app/api/jobs/[id]/stream/route.ts` に `GET` Route Handler を新設。
  責務は worker が publish した `JobEvent` を SSE で browser へ中継する薄い subscribe⇔SSE
  アダプタ ―― Next.js 16 の非同期 `params`(`{ params: Promise<{id}> }`)から `jobId` を取得 →
  `redis`(node-redis v6)クライアントを 1 本、リクエストごとに新規生成 → 13.8 `publisher.ts` の
  `jobChannel(jobId)` で命名を単一ソース化した Redis チャンネルへ subscribe → 受信メッセージ
  (worker が 13.3 `jobEventSchema` で検証・publish 済みの JSON 文字列)をそのまま
  `data: <message>\n\n` として `ReadableStream` へ enqueue。ブラウザ切断時は
  `ReadableStream.cancel()`(fetch 標準: 消費側切断で自動発火)で `unsubscribe`→`quit` を
  best-effort 実行。`export const dynamic = "force-dynamic"` で静的化を無効化。
- **[設計] DB replay は非スコープ(R3.6 の「DB **or** Redis」を継承)**: 13.3 `events.ts` の
  doc コメントは「DB(履歴)・Redis(生配信)のどちらか/両方/どちらも無し」を許容すると明記。
  14.2 は生配信(Redis pub/sub)のみを配線 ―― `job_event` テーブル(13.7)からの履歴 replay
  (遅れて subscribe したクライアントへの巻き戻し配信)は 13.8 `stores.ts` に read 系メソッド
  (`JobEventStore.append` のみで list 未実装)が無く、Task 13 の凍結境界を再度開くことになる
  ため後続タスク化(未タスク化 ―― 14.1 の「非スコープ → 未タスク化」precedent に倣う)。
- **[解決] 単一編集境界 × 新規依存(14.1 と同型)**: 宣言境界は `route.ts` のみだが `redis`
  クライアント構築に外部 SDK が新規必要 ―― `apps/web/package.json` へ境界拡張して
  `"redis": "^6.1.0"`(`apps/worker` と同バージョン)を追加。`allowBuilds`(pnpm-workspace.yaml)
  は既に `redis: false`(lifecycle script 無し・audited、Task 13.8)としてワークスペース全体に
  適用済みのため追加監査は不要 ―― `pnpm install` は `Lockfile passes supply-chain policies` で
  clean(churn は importer 追加のみ)。
- **[解決] Redis チャンネル命名の単一ソース化**: 新規 `jobChannel` 抽象を web 側に複製せず、
  publish 側(`apps/worker/src/publisher.ts`, 13.8)が既に export している `jobChannel()` を
  `@vaz/worker/src/publisher` から直接 import ―― 14.1 が `@vaz/worker/src/{inngest,main}` を
  境界超えで再利用した precedent と同型(ADR-2: web は Redis クライアント自体は直接構築するが、
  チャンネル命名という「契約」は worker 側に一元化)。
- **TDD(RED-GREEN)**: `apps/web/tests/jobs-stream-route.spec.ts` を先行作成し RED(`route.ts`
  不在 → `Failed to resolve import`)→ 実装 → GREEN(3 tests)。`redis` を `vi.mock` して
  `createClient` をフェイクへ差し替え ―― 実 Redis・ネットワーク非依存。ケース: (a) 正常系 =
  `job:<jobId>` へ subscribe し、publish されたメッセージを `data: <message>\n\n` として
  ストリームへ転送、(b) ブラウザ切断(`stream.cancel()`)→ `unsubscribe`/`quit` 呼出、(c) 接続
  失敗(`client.connect()` reject)→ `controller.error()` でストリーム消費側に伝播(unhandled
  throw ではない)。
- **検証**: `mise run check` exit 0 ―― `typecheck`(`apps/web`/`apps/worker` 含む全鎖 tsc)
  Done、`lint`(biome)`Checked 100 files … No fixes applied`、`test:run` **219 passed**
  (216→+3、回帰なし)、`lint:model-ids` ✅、`audit` `No known vulnerabilities found`。
  `pnpm install` `Lockfile passes supply-chain policies`。
- **次**: Task 14.3（`api/jobs/[id]/approve/route.ts` ―― 承認イベント受信 → 中断中ワークフロー
  再開シグナル）。
- **14.3 完了**: `apps/web/src/app/api/jobs/[id]/approve/route.ts` に `POST` Route Handler を新設。
  責務は 14.1/14.2 と同型の薄い HTTP⇔engine アダプタ ―― body(`{ toolCallId, decision:
  approve|reject, args? }`, plan.md 契約)を手動検証 → `ApprovalSignal{jobId(URL param),
  stepId:toolCallId, approved:decision==="approve", args?}` を組み立て → `submitApproval`
  (`apps/worker/src/main.ts`, 13.6)で中断中ワークフローへ resume イベントを送出 → `{ ok: true }`
  を 202 で返す（14.1 と同じ fire-and-forget 決着 ―― resume 完走は待たず、進捗は 14.2 SSE で配信）。
- **[解決] `toolCallId`(HTTP 契約) × `stepId`(engine 相関キー) の命名差**: plan.md の
  Interfaces/Contracts は body を `{ toolCallId, decision, args? }` と明記するが、13.6 で確定した
  実際の中断/再開粒度は「AI SDK の個別 tool call」ではなく「supervisor plan の **step**」
  (`createDurableStepRunner` は `requiresApproval(stepId)`/`engineStep.run("approval:"+stepId, …)`
  で stepId 相関、`ApprovalGate`/`ApprovalSignal` も `stepId` フィールド、do.md Task 13.6 申し送り
  「承認 UI は…step-start イベント（kind）+ requiresApproval 述語で判定」)。Approval エンティティ
  (plan.md データモデル)や toolCallId→stepId のマッピングを持つ store も未実装(13.7/13.8 は
  JobEvent/AuditLog のみ)。よって 14.3 は HTTP 契約のフィールド名(`toolCallId`)をそのまま維持し、
  その**値**を engine 相関キー(`stepId`)として転送 ―― 承認 UI(14.5)は `step-start` `JobEvent` の
  `stepId` を読み、それを `toolCallId` として送信する契約になる(命名は plan.md 由来、値は
  stepId)。新規 schema/store は追加せず既存の 2 契約(HTTP/engine)を単一 route.ts でブリッジする
  だけに留めた(単一編集境界を維持)。
- **[非スコープ]** `ApprovalDeniedError.reason`(rejected/expired/misconfigured)は engine 内部で
  投げられ、`runJob`/`workflow.dispatch` の失敗として 14.2 の `error` `JobEvent` に流れる想定
  (13.6 が確定させた挙動) ―― 14.3 route 自身は resume 送出のみで、その後の workflow 失敗/成功は
  関知しない(14.1 の「送信は enqueue のみ、実行結果は SSE」precedent と同型)。
- **TDD(RED-GREEN)**: `apps/web/tests/jobs-approve-route.spec.ts`(jobs-route.spec.ts と同型)を
  先行作成し RED(`route.ts` 不在 → `Failed to resolve import`)→ 実装 → GREEN(6 tests)。
  `@vaz/worker/src/{inngest,main}` を `vi.mock` して engine/`submitApproval` を差し替え ―― 実
  Inngest SDK・ネットワーク非依存。ケース: (a) `decision:"approve"` → `submitApproval` を
  `{jobId,stepId,approved:true,args}` で呼出・202・`{ok:true}`、(b) `decision:"reject"` →
  `approved:false`・`args` 未指定時はキー自体を省略、(c) 不正 JSON → 400・未呼出、(d) `toolCallId`
  欠落 → 400・未呼出、(e) `decision` が approve/reject 以外 → 400・未呼出、(f) `submitApproval`
  失敗 → 500(unhandled throw ではない)。
- **検証**: `mise run check` exit 0 ―― `typecheck`(apps/web/apps/worker 含む全鎖 tsc)Done、
  `lint`(biome)`Checked 102 files … No fixes applied`、`test:run` **225 passed**(219→+6、
  回帰なし)、`lint:model-ids` ✅、`audit` `No known vulnerabilities found`。新規依存ゼロ
  (`@vaz/worker` は 14.1 で既に境界拡張済み)。
- **次**: Task 14.4（`features/jobs/useJobStream.ts` ―― SSE 消費フック）。
- **14.4 完了**: `apps/web/src/features/jobs/useJobStream.ts` に `"use client"` フック
  `useJobStream(jobId)` を新設。責務は `GET /api/jobs/:id/stream`(14.2)の消費のみ ――
  `fetch(/api/jobs/:id/stream, {signal})` → `response.body`(`ReadableStream<Uint8Array>`)を
  `getReader()` で読み進め、`{events: JobEvent[], latestEvent, status, error}` を返す。
  `status` は `connecting → open → closed`(または `error`)の 4 値。
- **[設計] SSE フレーム解析は自前実装せず `ai` の `parseJsonEventStream` を再利用**: `ai`
  (`@ai-sdk/provider-utils` 再 export, 既存依存・新規追加ゼロ)の `parseJsonEventStream({stream,
  schema})` は内部で `EventSourceParserStream` により `data: <json>\n\n` フレームを分解し
  `safeParseJSON` で `schema`(= `jobEventSchema`, 11.2)検証済みの `ParseResult<JobEvent>` を
  yield する ―― 14.1-14.3 が `@vaz/worker` の engine/publisher/`jobChannel` を境界超え再利用した
  precedent と同型(reuse-over-reinvent)。`EventSource`(ブラウザ標準)は不採用 ――
  `parseJsonEventStream` は `ReadableStream<Uint8Array>`(`Response.body`)入力を要求し
  `EventSource` はそれを公開しないため、`fetch` + `getReader()` を採用。
- **[設計] 不正フレームは drop-and-log(worker 側 `events.ts` の契約を継承)**:
  `ParseResult.success===false`(schema 不一致)は `console.error` に記録して次フレームへ継続、
  `error` state には反映しない ―― 13.3 `createJobEventSink` が壊れたイベントを
  「ログして捨てる」(store/publish しない)契約と対称(1 件の不正フレームで購読全体を
  落とさない)。
- **[設計] `jobId` が null/undefined の間は `status:"closed"`・fetch 発火なし**: 承認 UI(14.5)
  などジョブ未確定の呼び出し元が `useJobStream(null)` を安全に呼べるようにし、`jobId` が
  値を持った時点で `connecting` から再開する契約。
- **TDD(RED-GREEN)**: `apps/web/tests/useJobStream.spec.ts` を先行作成し RED(フック不在 →
  `Failed to resolve import`)→ 実装 → GREEN(6 tests)。`@testing-library/react` の
  `renderHook`/`waitFor` を使用し `fetch` を `vi.stubGlobal` で差し替え、`Response`/
  `ReadableStream`(jsdom 環境でも Node 組込みグローバルとして利用可能、14.2 の
  `jobs-stream-route.spec.ts` と同じ前提)で SSE バイト列を模擬 ―― 実 Route Handler・
  ネットワーク非依存。ケース: (a) `jobId:null` → fetch 未呼出・`status:"closed"`、
  (b) 正常系 = 2 件の妥当な `JobEvent` フレーム → `events` に順次累積・ストリーム終了で
  `status:"closed"`、(c) 不正フレーム混在 → 妥当フレームのみ蓄積・`console.error` 呼出・
  `error` は null のまま、(d) `fetch` reject →`status:"error"`・`error.message` 伝播、
  (e) `response.ok===false` → `status:"error"`、(f) unmount → `AbortController.abort()` で
  `signal.aborted===true`。
- **検証**: `mise run check` exit 0 ―― `typecheck`(apps/web/apps/worker 含む全鎖 tsc)Done、
  `lint`(biome)`Checked 104 files … No fixes applied`、`test:run` **231 passed**
  (225→+6、回帰なし)、`lint:model-ids` ✅、`audit` `No known vulnerabilities found`。
  新規依存ゼロ(`ai`/`@vaz/schemas` は既存依存)。
- **次**: Task 14.5（`features/jobs/ApprovalPanel.tsx` ―― 承認 UI、`"use client"`）。
- **14.5 完了**: `apps/web/src/features/jobs/ApprovalPanel.tsx` に `"use client"` コンポーネント
  `ApprovalPanel({ jobId, requiresApproval? })` を新設。`useJobStream`(14.4)の `events` から
  「未解決の `step-start`」を承認待ちステップとして導出し、承認/拒否/引数編集を
  `POST /api/jobs/:id/approve`(14.3)へブリッジする薄い UI アダプタ(R3.4)。
- **[設計] requiresApproval 述語 + kind 判定(13.6 申し送りに忠実)**: do.md Task 13.6 の申し送り
  「承認 UI は『どのステップが破壊的か』を step-start イベント(kind)+ requiresApproval 述語で判定」
  に従い、`requiresApproval?: (step:{stepId,kind}) => boolean` を props として受け取る
  (`@vaz/agents/approval-policy` の `isDestructive`/`destructiveTools` と同型の belt-and-suspenders
  設計)。既定値は `() => false`(何も承認待ちにしない)―― worker 側 `requiresApproval` gate が
  「配線済みだが未活性」(do.md Task 13.9 申し送り(c))な現状と対称にし、パネル側が独自に
  destructive kind を推測しない。呼び出し元(将来のページ配線)が worker 側の活性化と合わせて
  明示的に predicate を渡す契約。
- **[設計] 承認待ちステップの導出は event-sourced**: `step-start` イベントが在り、同じ `stepId` の
  `completion`/`error` がまだ来ていない最新のステップを「承認待ち」とみなす(`findPendingStep`)。
  supervisor の `dispatch` はステップを直列実行するため(`packages/agents/src/supervisor.ts`)実際に
  未解決ステップは常に最大 1 件だが、複数件でも安全なよう防御的にスキャンする。
- **[設計] 引数編集は素の JSON テキスト入力、事前入力なし**: `createDurableStepRunner`(13.6)は
  ステップの specialist 関数を呼ぶ**前**に承認 gate へ await するため、`tool-call` イベント
  (specialist 内部からのみ発火)はこの時点でまだ存在しない ―― 事前入力できる「元の引数」はクライア
  ントに無い。よって「引数編集」は任意の素の JSON 上書き(未入力なら `args` キー自体を省略、14.3の
  「args 未指定時はキー省略」契約を継承)として実装。拒否時は編集内容を送らない(`args` キー無し)。
  `TextInput`(既存 `global.scss` 登録済み Carbon コンポーネント、Chat.tsx と同型)を採用 ―― 新規
  Carbon コンポーネント(`TextArea` 等)は使わず単一ファイル境界(`ApprovalPanel.tsx` のみ)を維持
  (`global.scss` 非改変)。
- **[設計] ApprovalDeniedError の終端状態描画**: `error` `JobEvent.message` が worker
  `ApprovalDeniedError`(`apps/worker/src/main.ts`)の `` `Approval ${reason} for step "${stepId}".` ``
  形状に一致する場合(`rejected`/`expired`/`misconfigured`)、13.6 申し送り通り理由を抽出して専用の
  終端バナーを表示。一致しない `error`(specialist 自体の失敗等)は汎用エラー表示にフォールバック、
  さらにフォールバックとして `useJobStream` 自身の接続エラー(`status:"error"`)も表示 ―― 優先順位は
  承認フォーム > 承認拒否バナー > 汎用エラー > 接続エラー > 待機メッセージ。
- **[設計] state リセットは remount(key)、useEffect ではない**: 承認フォームの各種ローカル state
  (引数テキスト/送信中/送信エラー/決定済みフラグ)は `ApprovalDecisionForm` という子コンポーネントへ
  切り出し、親側で `key={pendingStep.stepId}` を付与 ―― 新しい承認待ちステップが現れると自然に
  remount されて state がリセットされる。当初は `useEffect(() => {...}, [pendingStep?.stepId])` で
  実装したが、effect 本体が `pendingStep` を参照しないため biome
  `lint/correctness/useExhaustiveDependencies` が「不要な依存」と検出 ―― blind に依存配列を削ると
  リセットが効かなくなる根本原因不一致のため、鍵付き remount パターンへ再設計して解決(醐 fix ではなく
  設計変更)。
- **[非スコープ]** `args`(edited)の specialist 実行への反映は 13.6 時点で `createDurableStepRunner`
  未実装(`decision.approved` のみ判定、`decision.args` は素通り)―― 14.3/14.5 は既存の配線(HTTP→
  engine)へ忠実に args を運ぶのみで、worker 側での適用は既存の未タスク化ギャップを継承。ページへの
  実配線(`Chat`/`page.tsx` からの `ApprovalPanel` 使用、`requiresApproval` predicate の実体)も
  14.5 の Boundary(`ApprovalPanel.tsx` 単体)外 ―― 未タスク化。
- **TDD(RED-GREEN)**: `apps/web/tests/ApprovalPanel.spec.tsx` を先行作成し RED(`ApprovalPanel` 不在
  → `Failed to resolve import`)→ 実装 → GREEN(**10 passed**)。`@/features/jobs/useJobStream` を
  `vi.mock` して制御された `events` 配列を注入(実 SSE ストリーム非依存)、`fetch` を `vi.stubGlobal`
  で差し替え(実 Route Handler 非依存)。ケース: (a) 承認待ちなしは待機メッセージ、(b)
  `requiresApproval` が true を返す `step-start` はフォーム表示、(c) false(既定)はフォーム非表示、
  (d) `completion` 済みステップはフォーム非表示、(e) 承認 → 編集した JSON 引数付きで POST、(f)
  拒否 → `args` キー無しで POST、(g) 不正 JSON → 送信されずエラー表示、(h) 送信 API 失敗 →
  エラー表示、(i) `Approval rejected` エラー → 拒否理由バナー、(j) 無関係なエラー → 汎用エラー
  表示。
- **検証**: `mise run check` exit 0 ―― `typecheck`(apps/web/apps/worker 含む全鎖 tsc)Done、
  `lint`(biome)`Checked 106 files … No fixes applied`、`test:run` **241 passed**(231→+10、
  回帰なし)、`lint:model-ids` ✅、`audit` `No known vulnerabilities found`。新規依存ゼロ
  (`@carbon/react` の `TextInput`/`Tag`/`Button`/`InlineNotification`/`Tile` は既存 `global.scss`
  登録済み、`pnpm install` 不要)。
- **Task 14（Web ジョブ API・SSE・承認 UI）完了**: 14.1–14.5 全緑。`POST /api/jobs` → SSE 配信
  (14.2) → 承認受信(14.3) → クライアント消費(14.4) → 承認 UI(14.5)まで HITL の HTTP⇔engine⇔UI
  往復が確立(R3.2/3.4/3.5/3.6)。ページへの実配線・`requiresApproval` 活性化・edited args の
  specialist 反映は未タスク化のまま(既存ギャップを継承、Phase 3 実運用 or 後続タスクで確定)。
- **次**: Task 15（承認中断→再開の耐久性 E2E）。

---

## 15. 承認中断→再開の耐久性 E2E（Phase 3）

翌日承認→再開完走と、worker 再起動跨ぎ完走を E2E で検証する。

_Boundary:_ `apps/web/tests/e2e/approval-resume.spec.ts`
_Depends:_ 14
_Requirements:_ 3.7, 3.8

- [x] 15.1 `tests/e2e/approval-resume.spec.ts` に「承認待ち中断→翌日承認→再開完走」の E2E を実装する。
  _Boundary:_ `apps/web/tests/e2e/approval-resume.spec.ts`
  _Depends:_ 14.5, 14.3
  _Requirements:_ 3.8
- [x]* 15.2 同 spec に worker 再起動跨ぎでのジョブ完走 E2E を追加する（3.7 はコア実装 13.6 で充足済み、E2E は後回し可）。
  _Boundary:_ `apps/web/tests/e2e/approval-resume.spec.ts`
  _Depends:_ 15.1
  _Requirements:_ 3.7

### Implementation Notes

- **[FLAG 継承 → ユーザー判断で解決]** 本タスクの前提は二重に環境依存する: (a) 本セッションに Docker
  daemon が無い（`/var/run/docker.sock` 不在）ため `docker-compose.yml` の Postgres/Redis/Inngest/
  worker コンテナ一式を起動不能（Task 8.1 から継続する FLAG。`apps/worker/src/main.ts`/`start.ts` の
  doc comment も「live verification is deferred — Task 8.1 FLAG / Task 15 E2E」と明記）。(b) Docker
  の有無に関わらず、`requiresApproval` は実配線で一度も活性化されていない ―― `apps/worker/src/start.ts`
  の `registerJobFunction(engine, deps, { emit })` は `requiresApproval`/`approvalGate` を渡しておらず
  (do.md Task 13.9(c)/14.5 が「配線済みだが未活性」「未タスク化」と明記済みのギャップ)、かつ
  `requiresApproval: (stepId: string) => boolean` はプロセス静的でジョブごとの計画から導出できない
  （`workflowStepSchema` に「承認要否」フラグ自体が無い）。後者を実配線するには `@vaz/schemas/workflows`
  と `apps/worker/src/main.ts`（いずれも Task 11.2/13 で凍結済みの境界）を横断する変更が要り、本タスクの
  単一ファイル境界を超える。両ブロッカーをユーザーに提示（AskUserQuestion）し、「`@vaz/worker/src/main.ts`
  の実プロダクションコード（`registerWorker`/`submitJob`/`submitApproval`/`runJob`/
  `createDurableStepRunner`/`createSupervisorWorkflow`）を、Inngest が満たす構造的ポート
  (`DurableEngine.createFunction`/`.send()`)のみ最小フェイクに差し替えて E2E 化する」方針を選択（プロダクション
  コード変更ゼロ、単一ファイル境界を厳守）。
- **[設計] fidelity の境界を明文化**: `POST /api/jobs`(14.1)/`GET /api/jobs/:id/stream`(14.2)/
  `POST /api/jobs/:id/approve`(14.3)自体は Task 14 で既に緑（HTTP⇔engine ブリッジの単体テスト済み）。
  本 E2E はそれらのルートが呼ぶ**同一の**関数（`registerWorker`/`submitJob`/`submitApproval`）を、
  ルートが内部で構築する実 Inngest クライアント（`createInngestEngine()`）の代わりに、同じ
  `DurableEngine` 構造的ポートを満たすインメモリフェイクに接続して呼び出す。フェイクは
  (a) `send({name:"job/requested"})` でハンドラを起動し、ジョブごとにチェックポイント用 `step.run`
  memo（**engine 側**に保持 ―― 実 Inngest のサーバサイド永続と対称）と `waitForApproval`
  （jobId+stepId 相関の pending Promise）を注入、(b) `send({name:"job/approval"})` で該当 pending
  Promise を解決 ―― Inngest の `step.run` memoize / `step.waitForEvent` 相関の実セマンティクスを模す。
  Task 13.6 の `durability.spec.ts`（`runJob`/`createDurableStepRunner` を直接呼ぶ単体テスト、
  「Live proof against a real engine is Task 15's durable E2E」と自己申告）とは層が異なり非重複 ――
  13.6 が検証しない `DurableEngine.createFunction`/`.send()` 結合（= route が実際に叩く境界）を本タスクが追加。
- **[設計] 「翌日承認」(R3.8) は ADR-3 の注入 Clock で証明**: 中断自体は未解決の Promise（`step.waitForEvent`
  の真の中断セマンティクスに忠実 ―― 時間経過では自然に解決しない）。承認到着前に `deps.now` を +24h
  進め、`step-start`(destructive) と `completion`(destructive) の `JobEvent.ts` 差が実際に 24h 以上
  あることを assert ―― 現実の 24 時間 sleep なしに「翌日承認」を決定的に証明。
- **[設計] worker 再起動跨ぎ（15.2, 任意）も同一ハーネスで追加**: チェックポイント memo を **engine
  インスタンス**（invocation ごとではなく）に持たせたことで、「同じ jobId で `send(job/requested)`
  を 2 回発火」するだけで Inngest の crash-recovery replay（再接続後に同一関数を再実行、完了済み
  step は memo から replay）を模せる。1 回目は破壊的ステップの承認待ちで意図的に unresolved のまま
  放置（realistic crash）、2 回目（"restart"）で非破壊ステップの specialist が再実行されないこと
  （呼び出し回数 1 のまま）と、承認後にジョブが完走することを assert。15.2 は tasks.md の `*`
  （「コア実装で受入基準は充足済み・E2E は後回し可」、Task 13.6 が該当メカニズムを既に単体で証明済み）
  につき必須ではないが、15.1 のハーネスに対する追加コストが小さいため同一ファイルに実装した。
- **TDD**: 本タスクは新規プロダクション実装を伴わない（Task 12–14 で実装済みの関数を検証する Verify
  専任タスク）ため、古典的 RED（未実装 → 失敗）は該当しない。代わりに「テストファイル不在 → 作成 →
  緑」を確認の単位とし、作成直後に 1 件（`toMatchObject({stepId: undefined})` が実際には存在しない
  キーと `undefined` 値のキーを区別してしまう matcher の癖により RED）→ `"stepId" in event` の
  明示チェックへ修正して GREEN、を経た。
- **検証**: `pnpm exec playwright test apps/web/tests/e2e/approval-resume.spec.ts` **6 passed**
  (chromium×3 + firefox×3)。`mise run test:e2e`（全 e2e スイート）**16 passed / 4 skipped**
  （chat-anthropic/chat-ollama は既存条件で skip、回帰なし）。`mise run check` 全緑 ――
  `lint`(biome) `Checked 107 files … No fixes applied`、`typecheck` 全鎖 `Done`、`test:run`
  **241 passed**（Task 14.5 時点の 241 と同数、回帰なし ―— 本タスクは `apps/web/tests/e2e/**` のみで
  vitest `include` 対象外のため vitest 件数は不変）、`lint:model-ids` ✅、`audit`
  `No known vulnerabilities found`。新規依存ゼロ（既存 `@vaz/worker`（`apps/web` は 14.1 で境界拡張
  済み）/ `@vaz/schemas` / `@playwright/test` のみ、production ファイル変更ゼロ）。
- **Task 15（承認中断→再開の耐久性 E2E）完了**: R3.5/3.7/3.8 を、実際に route が呼ぶ
  `registerWorker`/`submitJob`/`submitApproval` の結合レイヤーで証明。**申し送り（未タスク化を継続）**:
  (a) `requiresApproval`/`approvalGate` の実配線（`apps/worker/src/start.ts`）と、ジョブ計画から
  承認要否を導出できるようにする `@vaz/schemas/workflows` の拡張（例: `workflowStepSchema` への
  「要承認」フラグ追加）―— Docker が使える環境で `docker-compose.yml` 一式（Postgres/Redis/Inngest/
  worker）を起動した上で本当に `POST /api/jobs` → SSE → `POST /api/jobs/:id/approve` を直接叩く
  live E2E に格上げする際の前提。(b) edited `args` の specialist 反映、(c) `ApprovalPanel` の実ページ
  配線 ―— いずれも Task 13.9/14.5 由来の既存ギャップを継続。

---

## 16. (P) テレメトリ拡充と評価契約（Phase 4）

span 属性の付与、`GradeReport` 契約、logger の PII 非記録明文化を行う。

_Boundary:_ `packages/config/src/telemetry.ts`, `packages/schemas/src/eval.ts`, `packages/schemas/src/deps.ts`
_Depends:_ 7
_Requirements:_ 4.2, 4.5, 4.7

- [x] 16.1 (P) `packages/config/src/telemetry.ts` に span 属性 `jobId`/`userId`/agent 名を付与し、
  ワークフロー全体を単一トレースとして追跡可能にする（token/cost を Langfuse で可視化）。
  `jobId` は Phase 3 ジョブ経路で付与（同期チャットは null 可）、`userId` は認証確立（18.2, Phase 5）
  後に実値を付与し、それ以前は anonymous/省略とする。**機構のみ**（`enrichSpan`/
  `buildTelemetryAttributes` の配線）が対象で、`@vaz/agents#chat-agent.ts` から実際に
  `runtimeContext` を渡す配線は境界外・未タスク化（do.md Task 16.1 参照）—— 現時点では
  実 trace に `vaz.*` 属性は乗らない。
  _Boundary:_ `packages/config/src/telemetry.ts`, `packages/config/tests/telemetry.spec.ts`
  _Depends:_ 7（`userId` の実値付与は 18.2 後）
  _Requirements:_ 4.2
- [x] 16.2 (P) `packages/schemas/src/eval.ts` に `GradeReport`（outcome と behavior を別軸）契約を定義する。
  _Boundary:_ `packages/schemas/src/eval.ts`, `packages/schemas/tests/eval.spec.ts`
  _Depends:_ 7
  _Requirements:_ 4.5
- [x] 16.3 `packages/schemas/src/deps.ts` の logger 契約に PII 非記録（INFO 既定 off、sensitive-payload は opt-in）を明文化する。
  _Boundary:_ `packages/schemas/src/deps.ts`
  _Depends:_ 7
  _Requirements:_ 4.7

### Implementation Notes

- **16.3 完了**: `LogFields`/`Logger` の JSDoc を、2.4 が残した自己参照プレースホルダー
  （「opt-in は 16.3 で明文化」）から確定文面へ置き換えた。契約本体は変更なし（PII 非記録は
  2.4 で既に規定、do.md 記録済みの「型レベルでは強制せず behavioral contract」を維持）。
  明文化した点: (a) 対象は `debug`/`info`/`warn`/`error` の 4 メソッド全て（R4.7 文言は INFO のみ
  だが実際の呼び出し規約 — `route.ts`/`email.ts`/`ingest.ts` — はレベルを区別しないため、実務に
  即して全メソッドへ一般化。要件を下回らないため R4.7 非違反）。(b) opt-in の意味を具体化: 特定の
  メソッド選択（例: `debug`）ではなく、呼び出し側/実装側が明示的・目的を持って行う判断
  （専用のデバッグ経路を自前のフラグで有効化する等）であり、通常のログ呼び出しの既定挙動では
  ないこと。(c) 安全な既定パターンとして `packages/tools/src/email.ts` の `email.sent`
  （`{ messageId }` のみ記録、subject/body 非記録）を具体例として参照。
- **[非選択] "debug は既定 disable" という具体機構は明記しない**: 現行の 3 つの `Logger`
  実装（`apps/web/src/app/api/chat/route.ts`、`packages/tools/src/email.ts` は info 経由、
  `packages/rag/bin/ingest.ts` の `createConsoleLogger`）はいずれも `debug` を含む全レベルを
  条件なしで出力しており、レベル別の既定 off 機構を持たない。「`debug` が opt-in の指定席」と
  明記すると現行実装と矛盾するため採用せず、契約は「ペイロード内容についての呼び出し側の判断」
  にスコープした（型レベル強制なし = do.md Task 2.4 記録の方針を継続）。
- **TDD 適用外の判断根拠**: 本タスクは型シグネチャ・実行時ロジックを一切変更しない
  purely-documentation 変更（`Logger`/`LogFields` の公開 shape は不変）。2.2–5.4 で確立した
  「型のみ変更 → ephemeral type-probe で RED/GREEN」パターンは type shape の差分を検出する
  手段であり、shape が不変な本タスクには適用できない（probe を書いても常に GREEN で
  RED を作れない）。よって検証は (a) grep で自己参照プレースホルダーの消滅と旧 `Logger`/
  `LogFields` を import する既存コンシューマ（`packages/tools/src/email.ts`、
  `packages/rag/bin/ingest.ts`、`packages/rag/src/{ingest,retrieve}/index.ts`、
  `apps/web/src/app/api/chat/route.ts`、テスト各 spec）が無変更で型解決を継続すること、
  (b) 全ゲート回帰なしの 2 点で行った。
- **検証**: `mise run check` 全緑 — `lint:model-ids` ✅、`typecheck` 全 7 workspace projects
  `Done`（`@vaz/schemas` 含む consumer 側 transitive 型検査）、`lint`(biome) `Checked 109 files …
  No fixes applied.`、`test:run` **262 passed**（34 files、Task 16.2 完了時点と同数 = 回帰なし）、
  `audit` `No known vulnerabilities found`。新規依存ゼロ（コメントのみの変更）。

**Task 16（テレメトリ拡充と評価契約）完了**: 16.1–16.3 全緑。span 属性（`jobId`/`userId`/
`agentName`, R4.2）+ `GradeReport` 契約（outcome/behavior 別軸, R4.5）+ logger PII 契約の
明文化（R4.7）を確立。次は Task 17（`@vaz/evals` 3 層評価ハーネスと nightly CI）。

---

## 17. `@vaz/evals` 3 層評価ハーネスと nightly CI（Phase 4）

tier1 unit（MockModel）/ tier3 LLM-as-judge / nightly（コスト上限・退行検知）を実装する
（tier2 `recall@k` は Task 10 と共有）。

_Boundary:_ `packages/evals/package.json`, `packages/evals/src/unit/**`, `packages/evals/src/judge.ts`, `packages/evals/src/nightly.ts`, `packages/evals/tests/**`, `.github/workflows/eval-nightly.yml`, `vitest.config.ts`（17.2 が `packages` project の `include` へ `src/unit/**` を追加）
_Depends:_ 16, 10
_Requirements:_ 4.4, 4.5, 4.6

- [x] 17.1 `packages/evals/package.json` を作成し `@vaz/evals` として定義する。
  _Boundary:_ `packages/evals/package.json`
  _Depends:_ 16.2
  _Requirements:_ 4.4
- [x] 17.2 `src/unit/*.spec.ts` に tier1 unit（MockModel：ツール選択・ループ制御・スキーマ適合、毎 CI）を実装する。
  _Boundary:_ `packages/evals/src/unit/**`
  _Depends:_ 17.1
  _Requirements:_ 4.4
- [x] 17.3 `src/judge.ts` に tier3 LLM-as-judge（実モデル + evalite/promptfoo、`GradeReport` を生成）を実装する。
  _Boundary:_ `packages/evals/src/judge.ts`, `packages/evals/tests/judge.spec.ts`
  _Depends:_ 17.1, 16.2
  _Requirements:_ 4.4, 4.5
- [x] 17.4 `src/nightly.ts` に nightly 実行 + コスト上限を実装し、結果を Langfuse へ記録する。
  _Boundary:_ `packages/evals/src/nightly.ts`, `packages/evals/tests/nightly.spec.ts`
  _Depends:_ 17.3
  _Requirements:_ 4.4
- [x] 17.5 `.github/workflows/eval-nightly.yml` に `eval:nightly`（GitHub Secrets ゲート・コスト上限・ゴールデンセット退行検知）を実装する。
  _Boundary:_ `.github/workflows/eval-nightly.yml`
  _Depends:_ 17.4
  _Requirements:_ 4.6

### Implementation Notes

詳細な RED→GREEN・検証エビデンスは `pdca/do.md`（Task 17.1–17.5）に記録。要点のみ再掲:

- **17.1 完了**: `@vaz/evals` を source-only(JIT)パッケージとして定義（`type: module` /
  `exports: { "./*": "./src/*.ts" }` / `typecheck` echo marker）。leaf eval ハーネスで downstream
  consumer 無しのため型検査は consumers（tests / nightly CLI）で被覆。deps は `@vaz/agents`/`@vaz/config`/
  `@vaz/rag`/`@vaz/schemas`（workspace:*）+ `ai`/`zod`。
- **17.2 完了**: tier1 unit を `src/unit/**`（plan.md 指定、他4パッケージの `tests/**` 慣行とは別）に配置し
  root vitest `packages` project の include（`src/unit/**` を追加）で毎 CI 実行。`MockLanguageModelV4` +
  RAG `searchDocuments` 注入で **両ツール登録**下のツール選択（time vs search）・`isStepCount(5)` ループ上限・
  スキーマ適合（不正入力が `tool-error` として `execute()` 前に弾かれる / 境界値は通過）を無ネットワーク検証。
- **17.3 完了**: `gradeRun(trace, {model?})` を `generateText` + `Output.object({schema: gradeReportSchema})` で実装
  （`generateObject` は v7 で deprecated）。`buildJudgePrompt` を純関数 export しプロンプト内容も単体テスト可能に。
  outcome/behavior を独立採点（R4.5）。model は `options.model ?? resolveModel()`（ADR-3/R1.8 テストシーム、直書きなし）。
  ADR-4（evalite vs promptfoo）は 17.4 へ持ち越し、judge はフレームワーク非依存の純採点関数に留める。durable test は
  `tests/judge.spec.ts`。
- **17.4 完了 / [解決] ADR-4**: 外部ハーネス（evalite/promptfoo）は導入せず軽量な自前ランナーを実装
  （`gradeRun` が既にフレームワーク非依存で、外部依存追加のコストに見合う価値なし）。`runNightlyEval` が
  golden set を `createChatAgent` で駆動 → `gradeRun` で採点 → **token ベースのコスト上限**（`DEFAULT_COST_CAP_TOKENS`
  = 50,000、`EVAL_NIGHTLY_COST_CAP_TOKENS` で上書き可）で暴走防止、上限到達後の case は skip。退行は per-case
  baseline（`minOutcomeScore`/`minBehaviorScore`）比較で判定。CLI entrypoint は `initTelemetry()` 経由で全
  `generateText`/`streamText` に OTel span を有効化し Langfuse へ記録（既存パイプライン再利用、fail-soft）。
  退行検知時は非ゼロ終了。durable test は `tests/nightly.spec.ts`（agent/judge 双方に `MockLanguageModelV4` 注入）。
- **17.5 完了**: `eval-nightly.yml`（cron `0 17 * * *` + `workflow_dispatch`）。`if: secrets.ANTHROPIC_API_KEY != ''`
  で GitHub Secrets ゲート（fork 実行等で実モデル不在なら job skip）、`timeout-minutes: 20` + `concurrency`
  cancel-in-progress。`pnpm --filter @vaz/evals run eval:nightly` が golden set 実行・コスト上限強制・退行検知
  （非ゼロ終了で CI 失敗）を担い、CI 側は Secrets/`EVAL_NIGHTLY_COST_CAP_TOKENS` の受け渡しに限定。

**Task 17（`@vaz/evals` 3層評価ハーネス）完了**: 17.1–17.5 全緑。tier1 unit（`src/unit/**`、毎 CI）/ tier2 recall@k
（Task 10 共有）/ tier3 LLM-as-judge（`judge.ts`）+ nightly（`nightly.ts`、コスト上限・退行検知・Langfuse 記録）+
CI 配線（`eval-nightly.yml`、Secrets ゲート）を確立（R4.4/4.5/4.6）。model 解決は全て `resolveModel()` 経由で直書きなし。

### Post-review remediation（adversarial review 起因、TDD で修正）

Phase 4 の adversarial review で検出した nightly コスト上限のロジック不備を修正（回帰なし、RED→GREEN で実施）:

- **コスト上限が judge の消費トークンを未計上（R4.6 のスコープ漏れ）**: `gradeRun`（`judge.ts`）が
  `generateText` の `usage` を破棄していたため、`runNightlyEval` の `totalTokens` は agent 分のみで
  judge 分（採点呼び出し自体も実課金）を含まなかった。`gradeRun` の戻り値を `GradeReport` から
  `{ report, usage }`（`GradeRunResult`）へ変更し、`nightly.ts` で `usage.totalTokens + judgeUsage.totalTokens`
  を計上するよう修正。`tests/judge.spec.ts`/`tests/nightly.spec.ts` に検証テスト追加。
- **コスト上限 `0`/負値が全 case を黙って skip し「回帰なし」で緑終了（false-positive success）**:
  `resolveCostCapFromEnv` が非正値を有効値として素通ししていたため。非正値・非数値は unset 相当
  （default にフォールバック）へ変更し、export して直接テスト可能にした。加えて `NightlyRunSummary` に
  `allSkipped`（全 case が skip = 何も検証していない）を追加し、`main()` で非ゼロ終了させる
  （`hasRegression` だけでは all-skipped を検知できないため）。
- **case 単位の例外未捕捉**: `runNightlyEval` のループに try/catch が無く、1 case の例外
  （provider の一時エラー・judge のスキーマ拒否等）で残り case の結果が丸ごと失われていた。
  per-case try/catch を追加し、失敗 case は `{ skipped: true, reason: "case-failed", error }` として
  記録、ループは継続。`NightlyRunSummary.hasFailure` を追加し `main()` で非ゼロ終了。
- **`@vaz/evals` が誰の `tsc` にも到達しない**: leaf harness で downstream consumer が存在しないため、
  他パッケージの「typecheck echo（transitive 型検査に委ねる）」規約がそもそも成立しない。
  `package.json` の `typecheck` を、他タスクで確立済みの isolated tsc パターン（`--ignoreConfig --strict
  --module esnext --target es2022 --moduleResolution bundler --verbatimModuleSyntax --skipLibCheck
  --types node`）を `src/judge.ts`/`src/nightly.ts` に対して実行する実コマンドへ変更（echo marker 廃止）。
- **検証**: `pnpm exec vitest run --project packages packages/evals/tests/**` 27 tests 全緑
  （新規 11 追加：resolveCostCapFromEnv 5、judge usage 計上 1、allSkipped 1、case-failed 1、既存 4 更新）。
  isolated tsc（上記フラグ）exit 0。

---

## 18. (P) 認証と権限スコープ（Phase 5）

社内 IdP OIDC 連携方式を確定し、認証セッションからツール実行を `runtimeContext` の
ユーザー権限にスコープする。

_Boundary:_ `docs/spikes/phase5-idp.md`, `apps/web/src/lib/auth.ts`, `apps/web/tests/auth.spec.ts`,
`packages/schemas/src/auth-env.ts`, `packages/schemas/tests/auth-env.spec.ts`,
`packages/config/src/role-allowlist.ts`, `packages/config/tests/role-allowlist.spec.ts`,
`apps/web/package.json`, `apps/web/src/app/api/chat/route.ts`, `apps/web/tests/chat-route.spec.ts`,
`apps/web/src/app/api/jobs/route.ts`, `apps/web/tests/jobs-route.spec.ts`,
`packages/schemas/src/deps.ts`, `packages/agents/src/chat-agent.ts`,
`packages/agents/tests/chat-agent.spec.ts`
_Depends:_ 14
_Requirements:_ 5.1

- [x] 18.1 `docs/spikes/phase5-idp.md` に IdP 連携方式（Auth.js / 社内標準、Entra ID / Google Workspace）の確定結論を記録する。
  _Boundary:_ `docs/spikes/phase5-idp.md`
  _Depends:_ 14
  _Requirements:_ 5.1
- [x] 18.2 `apps/web/src/lib/auth.ts` に OIDC 認証を実装し、セッション権限を `runtimeContext`
  （`{ userId, role }`）へマップして tool 実行を deps 経由でスコープする。
  _Boundary:_ `apps/web/src/lib/auth.ts`, `apps/web/tests/auth.spec.ts`,
  `packages/schemas/src/auth-env.ts`, `packages/schemas/tests/auth-env.spec.ts`,
  `packages/config/src/role-allowlist.ts`, `packages/config/tests/role-allowlist.spec.ts`,
  `apps/web/package.json`
  _Depends:_ 18.1
  _Requirements:_ 5.1
- [x] 18.3 `apps/web/src/app/api/chat/route.ts` と `apps/web/src/app/api/jobs/route.ts` で
  `auth()`/`toRuntimeContext()` を呼び、`packages/schemas/src/deps.ts` に追加する
  `AgentDeps.runtimeContext`（`{ userId, role }`）へ橋渡しする配線を実装する（chat 経路は
  `deps.runtimeContext`、jobs 経路は `JobRequest.userId`）。実 IdP テナント（Entra ID/Google
  Workspace）が用意された環境で `/api/auth/signin` の実ラウンドトリップを実証する（テナント未提供の
  間は deferred のまま明記する）。
  _Boundary:_ `apps/web/src/app/api/chat/route.ts`, `apps/web/tests/chat-route.spec.ts`,
  `apps/web/src/app/api/jobs/route.ts`, `apps/web/tests/jobs-route.spec.ts`,
  `packages/schemas/src/deps.ts`, `packages/agents/src/chat-agent.ts`,
  `packages/agents/tests/chat-agent.spec.ts`
  _Depends:_ 18.2
  _Requirements:_ 5.1

### Implementation Notes

- **18.2 完了**: `apps/web/src/lib/auth.ts`（新規）に Auth.js（`next-auth@5.0.0-beta.31`、`docs/spikes/phase5-idp.md`
  決定）を JWT session strategy で実装（R5.1）。`NextAuth({ providers, session: {strategy:"jwt"}, callbacks:{jwt,session} })`
  を構成し、`handlers`/`auth`/`signIn`/`signOut` を export。
- **[境界拡張, 8.5/9.1 前例に倣う]** 主境界（`apps/web/src/lib/auth.ts`）に加え、スパイクの申し送り（§11）どおり
  以下 2 ファイルを新規追加: `packages/schemas/src/auth-env.ts`（`authEnvSchema`/`parseAuthEnv`、`AUTH_IDP: enum(["entra-id",
  "google-workspace"]).default("entra-id")` — `aiEnvSchema`/`AI_PROVIDER` と同型だが無関係な関心事のため別ファイルに分離）、
  `packages/config/src/role-allowlist.ts`（`VazRole = "admin"|"member"`、`ADMIN_EMAILS`（既定空）+ `resolveVazRole(email,
  adminEmails=ADMIN_EMAILS)` — `MODEL_ALLOWLIST` と同じ「単一正当な配置場所」パターン）。`apps/web/package.json` に
  `next-auth@5.0.0-beta.31` を追加（`allowBuilds` 追記不要 — `npm view next-auth@beta scripts` で `postinstall`/`install`/
  `prepare` 無しを確認済み）。
- **[設計] role は IdP claim を信用しない**（スパイク §7 の申し送りを消化）: Entra ID App Roles と Google Workspace
  OIDC id_token の非対称性を避けるため、`resolveJwtRole(email)` が認証済みメールを `@vaz/config` allowlist に通す。
  `jwt` callback は `user.email`（sign-in 時のみ利用可）から role を解決し `token.role` へ保存、`session` callback が
  `session.user.role`/`session.user.id`（`token.sub`）へ反映。`toRuntimeContext(session)` が最終的な
  `{ userId, role }`（plan.md §Interfaces の `runtimeContext` 形状）を返す純関数。
- **[型] next-auth 型のはまりどころ 3 点**: (1) `declare module "next-auth/jwt" { interface JWT {...} }` は同モジュールからの
  型 import（`import type { JWT } from "next-auth/jwt"`）が無いと `TS2664`（augmentation 対象が解決できない）——
  公式 doc の augmentation 例に倣い import を追加（`noUnusedLocals` 対応で `export type { JWT }` として再 export）。
  (2) `Session["user"]` の augmentation は公式サンプルの `& DefaultSession["user"]` ではなく `& User`（`next-auth` の
  named export）で交差させる —— 本バージョンの `DefaultSession.user` は optional (`user?: User`) のため `DefaultSession["user"]`
  は `User | undefined` になり意図しない型になる。(3) `session` callback の `session.user.id` は `AdapterUser.id: string`
  （database strategy 分岐）との交差型のため常に非 null `string` 要求——JWT strategy では `token.sub` が sign-in 時に
  必ず設定される不変条件のため `token.sub as string` で解決（コメントで根拠を明記）。`Google({})`/`MicrosoftEntraID({issuer})`
  の資格情報（`AUTH_GOOGLE_ID`/`_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`）は Auth.js の env 命名規約で自動注入
  （Context7 evidence, 明示 wiring 不要）。
- **TDD（durable test）**: `packages/schemas/tests/auth-env.spec.ts`（4 tests: 既定値/明示上書き/空文字→既定/不正値 throw）、
  `packages/config/tests/role-allowlist.spec.ts`（4 tests: 既定 member/allowlist 一致で admin/大文字小文字非依存/
  委譲既定引数）、`apps/web/tests/auth.spec.ts`（9 tests: provider 選択 2、role 解決 2、runtimeContext 変換 3、
  NextAuth wiring 2）。各 RED（モジュール未解決 `Cannot find package`）→ GREEN を確認済み。`next-auth` 本体は
  telemetry.spec.ts の `ai`/`@ai-sdk/otel` モック前例に倣いモック化（実 `next-auth/lib/env.js` が bare `next/server`
  import を持ち、Vitest/Vite の module 解決（Turbopack 前提の next-auth ecosystem 制約、本コードの不具合ではない）
  で解決できないため——ネットワーク非発火・高速なユニット境界を維持）。
- **[申し送り／未接続 → 18.3 で解消]** ルーティング配線は 18.2 の境界外だった（`/sdd-validate-impl` 起因で
  18.3 として起票、本セッションで実施済み）。加えて実 IdP テナント（Entra ID/Google Workspace の実クライアント
  登録）は依然本セッションでは用意されていないため、実 OAuth ラウンドトリップは 8.1 image-pull FLAG と同種の
  deferred 項目として残存——到達可能な IdP テナントが用意された環境で `/api/auth/signin` の実ラウンドトリップを
  実証する（18.3 のスコープからも明示的に除外）。
- **検証**: auth-env.spec.ts 4 passed / role-allowlist.spec.ts 4 passed / auth.spec.ts 9 passed、`mise run test:run` =
  **41 files / 306 passed**（回帰なし）、`mise run typecheck` exit 0（apps/web tsc が auth.ts を実型検査）、
  `mise run lint` = `Checked 122 files … No fixes applied`（初回 import 順の 1 file を `lint:fix` で整形＝formatting のみ、
  logic 不変）、`mise run lint:model-ids` ✅、`mise run audit` = No known vulnerabilities、`pnpm install --frozen-lockfile`
  = `Already up to date`。

- **18.3 完了**: `packages/schemas/src/deps.ts` に `RuntimeContext`（`{userId, role}`、`role` は plain
  `string`——leaf package は `@vaz/config` の `VazRole` に依存できないため、`AuthRuntimeContext` と構造的互換）
  と `AgentDeps.runtimeContext?`（`AgentDeps.audit` の「消費者が現れる前に宣言する」前例に倣う）を追加。
  `apps/web/src/app/api/chat/route.ts` は `auth()`/`toRuntimeContext(session)` を呼び `deps.runtimeContext` へ
  橋渡し、`apps/web/src/app/api/jobs/route.ts` は同様に `JobRequest.userId` へ橋渡し（旧 `userId: null` 固定
  コメントを解消）。両ルートとも未認証を弾かない（`{userId: null, role: null}` を通すだけ）——実 IdP テナント
  無しの現状で既存 E2E（`chat-anthropic.spec.ts`/`chat-ollama.spec.ts`、いずれもログインフロー無し）を壊さない
  ための意図的な設計判断。
- **[設計変更, 起票時からの修正]** 当初 18.3 の記述は `packages/agents/src/chat-agent.ts` の
  `ChatAgentStreamOptions` に `runtimeContext` を追加する想定だったが、実装時に `AgentDeps` 側へ変更——
  (a) `route.ts` は `deps` をリクエストごとに新規生成しているため `AgentDeps` もリクエストスコープであり、
  `ChatAgentStreamOptions` に分離する実質的な利益がない、(b) `ChatAgentStreamOptions` 経由だと `buildChatTools`
  の呼び出しタイミング（`createChatAgent` 構築時、`stream()` 呼び出し前）との整合のため内部で deps を再構成
  する必要があり、ESM の同一モジュール内呼び出しは `vi.spyOn` で観測できず配線の検証が困難、という 2 点から
  `AgentDeps.runtimeContext`（`deps.ts`）に一本化。`chat-agent.ts` はドキュメント更新のみ（型は自動で流れる）。
  plan.md §File Structure Plan も合わせて更新。
- **[設計] 現時点では「宣言のみ」——tool 側の権限分岐は未実装**: R5.1 は「tool 実行を deps 経由でスコープする」
  ことを要求するが、具体的な role ゲーティング規則（どの tool を admin 限定にするか等）はどの設計文書にも
  定義されていない。仕様に無い認可ルールを創作しないという方針のもと、18.3 は `deps.runtimeContext` を
  実際の HTTP リクエストから正しく流し込む配線のみを実装し、それを読む具体的な tool 側チェックは対象外
  （将来 Task 19/20 またはそれに続くタスクの範囲）。
- **TDD（durable test）**: `packages/agents/tests/chat-agent.spec.ts`（+1: `deps.runtimeContext` 併存時も
  ストリーミング挙動が不変であることを固定——`AgentDeps` への型追加は型レベルの変更のみで実行時分岐が
  無いため、この回帰テストが実質的な検証手段）、`apps/web/tests/chat-route.spec.ts`（+2: 認証済み
  session→`deps.runtimeContext` 写像、未認証→`{userId:null,role:null}`）、`apps/web/tests/jobs-route.spec.ts`
  （+1: 認証済み session→`JobRequest.userId` 写像）。各 RED（`toRuntimeContextMock`/`createChatAgent`/
  `submitJob` への呼び出しが発生しない）→ GREEN を確認済み（`@/lib/auth` を `vi.mock` で完全モック化——実
  `next-auth` の import は auth.spec.ts と同じ理由で Vitest 解決不可のため、ルート側テストでは元から避ける
  設計）。
- **検証（18.3）**: `mise run test:run` = **41 files / 310 passed**（回帰なし、+4 tests）、`mise run typecheck`
  exit 0、`mise run lint` = `Checked 122 files … No fixes applied`（import 順で `lint:fix` 1 回、logic 不変）、
  `mise run lint:model-ids` ✅、`mise run audit` = No known vulnerabilities。

**Task 18（認証と権限スコープ）完了**: 18.1（IdP 方式決定）+ 18.2（Auth.js 実装・role/userId → runtimeContext
写像）+ 18.3（`route.ts`/`jobs/route.ts` から `deps.runtimeContext`/`JobRequest.userId` への実配線）で R5.1 を
充足。実 IdP テナントでの `/api/auth/signin` ラウンドトリップ実証のみ、テナント未提供のため deferred のまま
（8.1 image-pull FLAG と同種）。

---

## 19. (P) プロンプトインジェクション防御と破壊的ツール抑止（Phase 5）

<!-- 19.1 完了 (2026-07-11): packages/agents/src/prompt.ts に formatRetrievedContext(chunks)/
     toRetrievedContextMessage(chunks) を実装。RetrievedChunk[] を RETRIEVED_CONTEXT_BEGIN/END
     区切り + untrusted 通知文で囲み、role:"user" メッセージとして返す（role:"system" には決して
     しない = system prompt へ非混合を型で保証）。空配列は ""/null（何も注入しない）。9.1 の
     rag.ts docstring が「delimiting はagentの仕事」と予告していた地点。呼び出し元（chat-agent の
     searchDocuments tool 結果、supervisor の rag-research findings）への実配線は本タスクの
     Boundary 外のため未着手 — 関数は用意済み、次段の消費側タスクで import する想定。
     tests: prompt.spec.ts 9 件（純関数、network/DB-free）。-->
<!-- 19.2 完了 (2026-07-11): packages/agents/src/approval-policy.ts の createToolApprovalPolicy を拡張。
     新規 export isExternallyDrivenTurn(messages) が 19.1 の RETRIEVED_CONTEXT_BEGIN 区切りを messages 中の
     テキスト（string content / part 配列の type:"text" いずれも対応）から検出。ツール側 needsApproval が
     boolean/predicate いずれかで「宣言」されている（＝approval-capable、isApprovalCapable ヘルパ）状態で
     externally-driven turn が真の場合、needsApproval predicate の当該呼び出し限りの評価結果（trusted input
     前提で書かれている）を上書きして 'user-approval' を強制——lethal trifecta 下で predicate が承認をバイパス
     できないようにする（R5.3）。宣言そのものが無いツール（getTime 等）は外部コンテキスト下でも非対象のまま
     （R5.3 のスコープは「破壊的ツール」）。既存の destructiveTools/isDestructive/needsApproval:true の各シグナル
     は非破壊的に維持（そのまま unconditional destructive のショートサーキットが先に効く）。isDestructive フックへ
     messages を追加引数として渡すよう後方互換に拡張（呼び出し側が独自の外部駆動判定を組めるように、モジュール先頭
     docstring が予告していた設計）。tests: approval-policy.spec.ts 5→14 件（+9、pure/network-free、19.1 の
     toRetrievedContextMessage を実際に使って結合的に検証）。→ index.ts へは未再エクスポート（19.1 と同じ理由で
     Boundary 外、テストは ../src/approval-policy を直接 import）。-->

RAG 結果を区切りコンテキストとして隔離し、外部読取駆動時に破壊的ツールを無効/HITL 化、
外部送信ツールに宛先許可リストを強制する（lethal trifecta / Rule of Two）。

_Boundary:_ `packages/agents/src/prompt.ts`, `packages/agents/src/approval-policy.ts`, `packages/tools/src/allowlist.ts`
_Depends:_ 12, 9
_Requirements:_ 5.2, 5.3, 5.4

- [x] 19.1 `packages/agents/src/prompt.ts` に RAG 結果を明示区切りのコンテキストブロックとして
  注入する（system プロンプトへ混合しない、untrusted 前提）。
  _Boundary:_ `packages/agents/src/prompt.ts`
  _Depends:_ 12.1, 9.4
  _Requirements:_ 5.2
- [x] 19.2 `packages/agents/src/approval-policy.ts` を拡張し、外部読取駆動ターン（RAG 結果等）で
  破壊的ツールを無効化 or HITL 承認必須にする。
  _Boundary:_ `packages/agents/src/approval-policy.ts`
  _Depends:_ 12.2
  _Requirements:_ 5.3
- [x] 19.3 `packages/tools/src/allowlist.ts` に外部送信ツール（email 等）の宛先許可リスト強制を実装する。
  _Boundary:_ `packages/tools/src/allowlist.ts`
  _Depends:_ 12.2
  _Requirements:_ 5.4

### Implementation Notes

- **19.3 完了**: `packages/tools/src/allowlist.ts` に R5.4 の宛先許可リスト強制を実装。
  `RECIPIENT_ALLOWLIST`（既定空、`MODEL_ALLOWLIST`/`ADMIN_EMAILS` と同じ governance＝レビュー済み
  コミットのみ許容、env/runtime トグルではない）+ `isAllowedRecipient(recipient, allowlist?)`
  （大文字小文字非依存・前後空白除去、`resolveVazRole` と同型の正規化）+
  `assertAllowedRecipient(recipient, allowlist?)`（不許可なら `RecipientNotAllowedError` を throw、
  `supervisor.ts` の `SpecialistUnavailableError` と同型のカスタム Error クラス）。
- **[設計判断] HITL 承認との関係（Rule of Two）**: 19.2 の外部読取駆動 HITL 強制は「承認者が宛先を
  精査する」ことを保証しない別軸の防御であり、本許可リストは承認の有無に関わらず不許可の宛先を
  到達不能にする独立した第二の防御として設計（docstring に明記）。
- **[境界厳守 → email.ts 未配線]**: Boundary は `allowlist.ts` のみ（Task 19 全体の Boundary にも
  `email.ts` は非含）。`email.ts`（12.3）の docstring は「宛先許可リスト（R5.4）は Task 19.3 — ここでは
  ない」と明記しており、`createEmailCapability` の `execute` へ `assertAllowedRecipient` を配線する
  ことは本タスクの境界外（19.1 の `toRetrievedContextMessage`/19.2 の `isExternallyDrivenTurn` と同じ
  「定義は今、配線は消費側タスクで」の前例を継承）。同じ理由で `packages/tools/src/index.ts`
  （別境界）への re-export も未実施 — テストは `../src/allowlist` を直接 import。
  Coverage Matrix は R5.4 を本タスク単独で充足と記すが、実行時強制（プロダクション配線）は将来の
  consumer タスクに委譲される状態である点を申し送る。
- **TDD**: `packages/tools/tests/allowlist.spec.ts`（新規、10 tests、pure/network-free）を先行作成し
  RED（`Cannot find module '../src/allowlist'`）→ GREEN（10 passed）を確認。
- **検証**: `pnpm exec vitest run --project packages packages/tools/tests/allowlist.spec.ts` 10 passed。

---

## 20. (P) ツール実行監査ログ（Phase 5）

`AgentDeps.audit` sink 契約を確定し、agent lifecycle で全ツール実行を発火、web/worker
双方の DB sink で永続化する（発火点は `@vaz/agents` 単一箇所）。

_Boundary:_ `packages/schemas/src/deps.ts`, `packages/agents/src/audit-hook.ts`, `apps/web/src/lib/audit.ts`
_Depends:_ 12, 14, 16
_Requirements:_ 5.5

- [x] 20.1 `packages/schemas/src/deps.ts` の `AgentDeps.audit` sink 契約と `AuditEntrySchema`
  （who/job/tool/args）を確定する（Phase 1 は no-op 許容）。
  _Boundary:_ `packages/schemas/src/deps.ts`
  _Depends:_ 12.1, 16.3
  _Requirements:_ 5.5
- [x] 20.2 `packages/agents/src/audit-hook.ts` を作成し、agent ループの lifecycle で全ツール
  呼び出しを `deps.audit` へ発火する（web/worker 共通発火点）。
  _Boundary:_ `packages/agents/src/audit-hook.ts`
  _Depends:_ 20.1
  _Requirements:_ 5.5
- [x] 20.3 `apps/web/src/lib/audit.ts` に web 経路の `deps.audit` DB sink 実装を供給する。
  _Boundary:_ `apps/web/src/lib/audit.ts`
  _Depends:_ 20.1, 14.1
  _Requirements:_ 5.5

### Implementation Notes

- **20.1 完了**: `packages/schemas/src/deps.ts` に `auditEntrySchema`(Zod)を追加し、Task 2.4 の
  プレーン `interface AuditEntry` を `z.infer<typeof auditEntrySchema>` へ置換(構造は不変:
  userId/jobId は nullable、tool/args/ts)。`jobId` は `z.uuid()`(`job.id` FK と対応、
  `workflows.ts` の `jobEventSchema` と同じ判断)、`ts` は `z.date()`(`JobEvent.ts` の ISO 文字列と
  異なり、`AuditEntry` は agent lifecycle フック → `deps.audit.record()` → DB sink 行マッパーの
  in-process 経路のみで、SSE のようなシリアライズ境界が無いため)。`AuditSink`(関数メンバーを持つ
  ため Zod 化不可)はプレーン interface のまま(既存方針を維持)。
  既存消費者(`apps/worker/src/audit.ts`・`stores.ts`・`tests/audit.spec.ts`、Task 13.4/13.7)は
  型が構造的に同一のため無改修で緑を維持。
  **TDD**: `packages/schemas/tests/deps.spec.ts`(新規、8 tests)を先行作成し
  RED(`auditEntrySchema` は `undefined` → `TypeError`)→ GREEN(8 passed)を確認。
  **検証**: `pnpm exec vitest run --project packages packages/schemas/tests/deps.spec.ts` 8 passed;
  リグレッション確認で `--project packages`(19 files/180 tests)・`--project worker`(8 files/58 tests)も全緑。
- **20.2 完了**: `packages/agents/src/audit-hook.ts` に `createAuditHook(deps, options?)` を新設。
  `@vaz/agents` を単一の発火点(web/worker 共通)にする、というオーナーシップ(plan L120-121)を、
  `streamText`/`generateText` の `onToolExecutionStart`(`ai@7.0.14`、ツール呼び出し毎・`toolApproval`
  ゲート通過後・実 `execute` 直前に発火)へ直接 spread 可能なオブジェクト `{ onToolExecutionStart }`
  として実装(`ToolApprovalPolicy` が `streamText({toolApproval})` へ直接代入可能な形にした 12.2 の
  前例と同型)。`deps.audit` 未設定時は no-op(Phase 1 許容、`AgentDeps` 契約)。設定時は
  `{ userId: deps.runtimeContext?.userId ?? null, jobId: options.jobId ?? null, tool: event.toolCall.toolName,
  args: event.toolCall.input, ts: deps.now() }`(`auditEntrySchema`, 20.1)を `deps.audit.record(...)` へ渡す。
  `jobId` は `AgentDeps` ではなく `CreateAuditHookOptions` の引数(deps.ts 20.1 の「同期チャット経路は null」
  契約どおり、job 相関はプロセス全体の deps ではなく呼び出しごとの関心事のため)。
- **[解決] fail-open/fail-closed ポリシーの実地確認**: `apps/worker/src/audit.ts`(13.4)の docstring は
  「fail-open vs fail-closed ポリシーは発火点(本タスク)が決める」としていたが、`node_modules/ai/dist/index.js`
  の `notify()`(streamText 内部で `onToolExecutionStart` を呼ぶ関数)を実装確認した結果、
  callback の例外は空の `catch {}` で無条件に握り潰される――つまりこの lifecycle 点からは
  sink 失敗でツール実行を止める(fail-closed)手段が構造的に存在しない。本タスクではこれを
  「SDK 制約による fail-open」と明文化し直し、`deps.audit.record` の reject を自前で catch して
  `deps.logger.error`(tool/jobId/error のみ、R4.7: 生 `args` は非記録)で可視化する形に設計を確定した
  (SDK の握り潰しに埋没させず、失敗を最低限どこかに残す)。
- **境界厳守 → chat-agent.ts/supervisor.ts 未配線**: 本タスクの Boundary は `audit-hook.ts` 単体
  (`streamText` 呼び出しを持つ `chat-agent.ts`・`supervisor.ts` は非含)。19.1/19.3 と同じ「定義は今、
  配線は消費側で」の前例を継承し、実際の `streamText({ ...createAuditHook(deps) })` 配線は本 spec の
  タスクグラフに残る consumer タスクへ委譲(現時点で `deps.audit` を渡す消費側呼び出しはまだ存在しない
  ため、配線しても即座に有効化はされない)。
- **TDD**: `packages/agents/tests/audit-hook.spec.ts`(新規、4 tests、pure/network-free)を先行作成し
  RED(`Cannot find module '../src/audit-hook'`)→ GREEN(4 passed)を確認(12.1/12.2 と同じ「単一ファイル
  Boundary でも既存 `packages/agents/tests/` に恒久テストを追加する」前例に追従)。
  **検証**: `pnpm exec vitest run --project packages packages/agents/tests/audit-hook.spec.ts` 4 passed;
  isolated tsc(`--ignoreConfig --strict --moduleResolution bundler`)exit 0; `mise run typecheck` exit 0;
  `mise run test:run` 45 files/348 tests passed(回帰なし); `mise run lint` clean(`lint:fix` で format 1 件補正)。
- **20.3 完了**: `apps/web/src/lib/audit.ts` に web 経路の `deps.audit` DB sink 実装を供給。
  行マッパー/insert(`toAuditLogRow`/`createAuditLogStore`, 13.8)と fail-loud persistence +
  R4.7-safe failure logging(`createAuditSink`, 13.4)は既に worker 側テストで網羅済みのため、
  重複実装せず `@vaz/worker/src/audit`・`@vaz/worker/src/stores` を import して再利用(14.1/14.2 の
  「`apps/web` は `@vaz/worker` をエンジン側の再利用可能ライブラリとして扱う」前例を継承、
  Boundary は `apps/web/src/lib/audit.ts` 単体のため worker 側は無改修)。web 側で新規に必要なのは
  `DATABASE_URL` からの Postgres クライアント合成のみ:`resolveWebAuditEnv(env)` で fail-fast 解決
  (`start.ts` の `resolveWorkerEnv` に倣う)、`pg.Pool`/Drizzle クライアントはモジュールスコープで
  遅延生成・プロセスキャッシュ(Next.js Route Handler の長寿命プロセス前提、リクエスト毎に新規 pool を
  開かない)。`createAuditSink(deps, env?)` はキャッシュ済み DB を使い毎回軽量に再合成
  (`deps.logger` はリクエスト毎に異なり得るため)。`pg`/`drizzle-orm` は動的 import のため import 時点
  では実接続なし。新規依存: `apps/web/package.json` に `pg`/`drizzle-orm`(dependencies)・
  `@types/pg`(devDependencies)を worker/rag と同一 version range で追加。
  **[境界厳守 → chat/route.ts 未配線]**: 20.2 と同じ「定義は今、配線は消費側で」の前例を継承し、
  `deps.audit` への注入は本タスクの範囲外(Task 20 系列はここで完了、audit ログの実効化は
  route.ts 配線タスクへ委譲)。
  **TDD**: `apps/web/tests/audit.spec.ts`(新規、6 tests)を先行作成し RED
  (`Failed to resolve import "@/lib/audit"`)→ GREEN(6 passed)を確認。`pg`/`drizzle-orm/node-postgres`/
  `@vaz/worker/src/{audit,stores}` を `vi.mock` してテストを network-free に保ち、
  `vi.resetModules()` + 動的 import でモジュールキャッシュ状態をテスト間で分離(`initTelemetry` と
  同じパターン)。
  **検証**: `pnpm exec vitest run --project web apps/web/tests/audit.spec.ts` 6 passed;
  `mise run typecheck` exit 0; `mise run check`(lint/typecheck/test:run/audit/lint:model-ids)全緑
  (`test:run` 46 files/354 passed、回帰なし+6 tests; `lint` 131 files clean; `audit` No known
  vulnerabilities; `lint:model-ids` ✅)。

---

## 21. 配線ハードニング（アドバーサリアルレビュー由来、Phase 3/4/5 remediation）

Task 18-20 は各プリミティブ（`createAuditHook`/`createToolApprovalPolicy`/
`isExternallyDrivenTurn`/`toRetrievedContextMessage`/`assertAllowedRecipient`）を
「定義は今、配線は消費側で」の前例で完了させたが、その消費側タスク自体が存在しないまま
Coverage Matrix が R5.2/5.3/5.4/5.5 を充足済みと記録していた（10R と同じ「アドバーサリア
ルレビュー由来ハードニング」パターンで是正）。加えてレビューは `apps/web` の `approve`/
`stream` ルートに認証が一切配線されていないこと（R5.1 の非対称配線）、`start.ts` の
try/finally 境界の外にリソース生成があること（resource leak）も検出した。

_Boundary:_ `apps/worker/src/start.ts`, `packages/tools/src/email.ts`,
`apps/worker/src/stores.ts`, `apps/worker/src/main.ts`,
`apps/web/src/app/api/jobs/[id]/approve/route.ts`,
`apps/web/src/app/api/jobs/[id]/stream/route.ts`, `apps/web/src/lib/jobs.ts`,
`packages/agents/src/chat-agent.ts`, `packages/agents/src/supervisor.ts`
_Depends:_ 13, 14, 18, 19, 20
_Requirements:_ 3.4, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5

- [x] 21.1 `apps/worker/src/start.ts` の `main()` を修正し、`pool`/`redisClient` の生成と
  `redisClient.connect()` を `try` の内側へ移す（現状 72-89 行が `try` の外にあり、
  `connect()` 失敗時に `finally` の解放がスキップされ両リソースがリークする）。
  _Boundary:_ `apps/worker/src/start.ts`
  _Depends:_ 13.9
  _Requirements:_ NFR-4
- [x] 21.2 `packages/tools/src/email.ts` の `createEmailCapability` の `execute` 冒頭に
  `assertAllowedRecipient(input.to)` を配線する（R5.4 の実効化）。allow-list が空の現状は
  委譲前と同じ「常に拒否」挙動になるが、それは許可リストの意図した既定(委任された
  `RECIPIENT_ALLOWLIST` 未設定)であり、`execute` が呼ばれる前に必ず検査される点が変化。
  _Boundary:_ `packages/tools/src/email.ts`
  _Depends:_ 19.3
  _Requirements:_ 5.4
- [x] 21.3 `apps/worker/src/stores.ts` に `JobStore`(`insert`/`findOwnerUserId`)を追加し、
  `apps/worker/src/main.ts` の `runJob` の冒頭で(オプショナルな `jobStore` 経由、他の
  シンクと同じ注入パターン)`job` テーブルへ `{id: jobId, userId, workflow:
  "supervisor-plan", status: "running"}` を挿入する。`job.userId` 列は Task 8 で定義済みだが
  一度も INSERT されておらず、21.4 の所有権照合の前提が存在しなかった(ジョブ完了/失敗時の
  status 更新は本タスクの範囲外、将来のタスクへ委譲)。
  _Boundary:_ `apps/worker/src/stores.ts`, `apps/worker/src/main.ts`
  _Depends:_ 13.7, 13.8
  _Requirements:_ 5.1
- [x] 21.4 `apps/web/src/lib/jobs.ts`(新規、`lib/audit.ts` の `DATABASE_URL` 遅延解決 + プロセス
  キャッシュ pool パターンを再利用)に `findJobOwnerUserId(jobId)` を実装し、
  `apps/web/src/app/api/jobs/[id]/approve/route.ts` と
  `apps/web/src/app/api/jobs/[id]/stream/route.ts` の両方で `auth()` を呼び、未認証は 401、
  ジョブ所有者と不一致は 403 とする。`stream` ルートには approve ルートと同じ
  `z.uuid().safeParse(jobId)` 検証も追加する(現状 stream 側のみ未検証だった)。
  _Boundary:_ `apps/web/src/lib/jobs.ts`, `apps/web/src/app/api/jobs/[id]/approve/route.ts`, `apps/web/src/app/api/jobs/[id]/stream/route.ts`
  _Depends:_ 18.2, 21.3
  _Requirements:_ 5.1
- [x] 21.5 `packages/agents/src/chat-agent.ts` に `buildStreamTextOptions(deps, options,
  messages)`(`buildChatTools` と同じ「配線判断を関数として切り出し、スタリームなしで単体
  テスト可能にする」前例)を追加し、`streamText` 呼び出しへ以下を配線する:
  `runtimeContext: { userId: deps.runtimeContext?.userId ?? null, agentName: "chat-agent" }`
  (R4.2)、`...createAuditHook(deps)`(R5.5)、`toolApproval: createToolApprovalPolicy()`
  (R3.4/5.3)、`prepareStep`(直前ステップの `searchDocuments` ツール結果から
  `toRetrievedContextMessage` で明示区切りメッセージを構築し次ステップの messages に注入、
  R5.2。これにより `isExternallyDrivenTurn` が実際にトリガ可能になる、R5.3)。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 9.6, 18.3, 19.1, 19.2, 20.2
  _Requirements:_ 3.4, 4.2, 5.2, 5.3, 5.5
- [x] 21.6 `packages/agents/src/supervisor.ts` の `document-generation` 特殊化エージェントの
  `generateText` 呼び出しへ `runtimeContext: { jobId, agentName: "document-generation" }`
  を配線する(R4.2。ツールを持たないため `toolApproval`/audit-hook は対象外)。
  _Boundary:_ `packages/agents/src/supervisor.ts`
  _Depends:_ 12.1, 20.2
  _Requirements:_ 4.2

### Implementation Notes

- **21.1 完了**: `apps/worker/src/start.ts#main` の `pool`/`redisClient` 生成と
  `redisClient.connect()` を `try` の内側へ移動(構築自体は I/O を発生させないため `try` 外に
  残すのは安全だが、`connect()` 以降は必ず内側)。**TDD**: `pg`/`drizzle-orm`/`redis`/
  `inngest/connect`/`../src/{main,audit,stores,events,publisher}` を `vi.doMock` した
  network-free テストで `redisClient.connect()` を reject させ、修正前は
  `pool.end()`/`redisClient.quit()` が呼ばれない(RED)→ 修正後は両方呼ばれる(GREEN)ことを確認。
- **21.2 完了**: `packages/tools/src/email.ts` の `createEmailCapability.execute` 冒頭で
  `assertAllowedRecipient(input.to, allowlist)` を呼ぶ(`allowlist` は新規
  `CreateEmailCapabilityOptions.allowlist`、既定は委譲済み `RECIPIENT_ALLOWLIST`)。**TDD**:
  非許可宛先で `RecipientNotAllowedError` を throw しかつ transport 未呼び出しであることを
  確認(RED→GREEN)。既存の送信系テスト(transport 注入/デフォルト transport/R4.7 ログ)は
  `allowlist: [VALID.to]` を注入するよう更新(許可リスト強制という意図した挙動変更のため)。
- **21.3 完了**: `apps/worker/src/stores.ts` に `JobStore`(`insert`/`findOwnerUserId`、
  `job` テーブルへの Drizzle 実装)を追加し、`apps/worker/src/main.ts#runJob` の冒頭
  (`parseJobRequest` 直後、dispatch 前)で `jobStore?.insert({id: jobId, userId, workflow:
  "supervisor-plan"})` を呼ぶ(オプショナル注入、失敗は fail-loud で dispatch 前に伝播)。
  `apps/worker/src/start.ts` で `createJobStore(db)` を `registerJobFunction` の
  `RunJobOptions.jobStore` へ実配線。**TDD**: `stores.spec.ts` に fake db(insert/select 双方)
  でのユニットテスト、`main.spec.ts` に「insert が dispatch 前に呼ばれる」「insert 失敗で
  dispatch されない(fail-loud)」「jobStore 省略は no-op」の3テスト、`start.spec.ts` に
  `registerJobFunction` へ渡る `jobStore` が `createJobStore` の戻り値であることを確認する
  配線テストを追加(いずれも RED→GREEN)。
- **21.4 完了**: 新規 `apps/web/src/lib/jobs.ts`(`lib/audit.ts` と同じ「`@vaz/worker` の
  JobStore を遅延生成・プロセスキャッシュ Postgres クライアント上で再利用」パターン)に
  `findJobOwnerUserId(jobId)` を実装。`approve`/`stream` 両ルートで `auth()` を呼び、
  未認証は 401、`findJobOwnerUserId` が返す owner と呼び出し者が不一致(owner が非null の場合
  のみ)は 403。owner が null(匿名投入または未記録)は authz 境界としない(Task 18.3 の匿名
  投入許容方針を継承)。`stream` ルートには `approve` ルートと同じ `z.uuid()` 検証も追加
  (従来 stream 側のみ未検証だった不整合を解消)。**TDD**: `jobs.spec.ts`(新規、env fail-fast +
  lazy client 構成)、`jobs-approve-route.spec.ts`/`jobs-stream-route.spec.ts` に
  401/403/owner-null-proceeds の3テストずつ追加、既存の振る舞いテストは `auth`/
  `findJobOwnerUserId` の既定モック(owner一致)で無改修のまま通過することを確認(RED→GREEN)。
- **21.5 完了**: `packages/agents/src/chat-agent.ts` に `buildStreamTextOptions` を追加
  (`buildChatTools` と同じ「配線判断を関数として切り出しスタリームなしで単体テスト可能にする」
  前例)。`streamText` へ `runtimeContext`(`deps.runtimeContext.userId` + 固定
  `agentName: "chat-agent"`、R4.2)・`...createAuditHook(deps)`(R5.5)・
  `toolApproval: createToolApprovalPolicy()`(R3.4/5.3)・`prepareStep`(直前ステップの
  `searchDocuments` 結果から `toRetrievedContextMessage` で明示区切りメッセージを構築し次
  ステップの messages に注入、R5.2)を配線。これにより 19.1 の delimiter が実際にメッセージ列
  に現れ、19.2 の `isExternallyDrivenTurn` が初めて実際にトリガ可能になった(R5.3)。**TDD**:
  `chat-agent.spec.ts` に `buildStreamTextOptions` の各配線(runtimeContext 形状・
  onToolExecutionStart が deps.audit.record を呼ぶ・toolApproval が需要承認ツールに
  user-approval を返す・prepareStep が searchDocuments 後に delimiter 付きメッセージを注入)
  を直接呼び出して検証する5テストを追加(RED→GREEN)。サニティチェックとして `toolApproval`
  配線を一時的に無効化し該当テストが失敗することを確認してから復元(テストの妥当性検証)。
- **21.6 完了**: `Specialist<K>` の型シグネチャに第2引数 `ctx: DispatchContext` を追加
  (既存の1引数カスタム specialist は TS の関数型変性で引き続き代入可能、破壊的変更なし)。
  `invoke`/`dispatch` 経由で `ctx`(`{jobId}`)を specialist 呼び出しへ伝播し、デフォルト
  `document-generation` specialist の `generateText` 呼び出しへ新規 export
  `buildDocumentGenerationRuntimeContext(jobId)` の戻り値を `runtimeContext` として配線
  (R4.2)。`runtimeContext` は AI SDK レベルの概念でモデルの `doGenerate` 呼び出しオプション
  には転送されないため、`buildDocumentGenerationRuntimeContext` を純関数として抽出し直接
  ユニットテスト。**TDD**: `supervisor.spec.ts` に「カスタム specialist が ctx.jobId を
  受け取る(シグネチャ伝播の検証)」「`buildDocumentGenerationRuntimeContext` の形状」の
  2テストを追加(RED→GREEN)。
- **[訂正] レビュー起因の誤検出**: アドバーサリアルレビューの CRITICAL 指摘「R4.1 テレメトリが
  全エージェント呼び出しで無効(`experimental_telemetry` が存在しない)」は AI SDK v6 API の
  誤認に基づく誤検出と判明・訂正。AI SDK v7 ではテレメトリは
  `registerTelemetry(new OpenTelemetry({enrichSpan}))`(`packages/config/src/telemetry.ts#initTelemetry`、
  `apps/web/instrumentation.ts` から起動時に一度呼ばれる)による**全呼び出し opt-out** 方式に
  変更されており、per-call `experimental_telemetry` は不要(`node_modules/ai/docs/08-migration-guides/23-migration-guide-7-0.mdx`
  で確認)。実際の残存ギャップは R4.2(`runtimeContext` 経由の jobId/userId/agentName 属性付与)
  のみで、これは 21.5/21.6 で解消。
- **検証**: `mise run check` 全緑 —
  `lint`(Biome, 133 files clean)、`lint:model-ids`(✅ ハードコードなし)、
  `typecheck`(全ワークスペース Done)、`test:run`(47 files / **388 passed**、
  Phase 5 直前の 354 から 21.1-21.6 の新規テスト 34 件を追加、既存回帰なし)、
  `audit`(No known vulnerabilities)。

---

## 22. 配線ハードニング追検出（アドバーサリアルレビュー 2巡目由来）

Task 21 完了後の 2 巡目アドバーサリアルレビューが 3 件の残存欠陥を検出した:
(1) `runJob` の `jobStore.insert` は Inngest 関数本体にあり、リトライ(`retries: 3`)と
承認 `waitForEvent` レジュームのたびに再実行されるため、素の insert では `job.id` PK 違反で
fail-loud し**リトライ/HITL レジュームが恒久破壊**される (CRITICAL);
(2) R5.3 の「外部駆動」taint は検索直後の 1 ステップにしか現れず、注入命令が数ステップ後に
破壊的ツールを呼ぶと強制承認を回避できる (MEDIUM);
(3) その修正で追加した `isExternallyDriven` が置換意味論だと防御を無言で弱められる、かつ
`approval-policy.ts` は Task 21 境界外 (MEDIUM/境界)。

_Boundary:_ `apps/worker/src/stores.ts`, `apps/worker/src/main.ts`,
`packages/agents/src/chat-agent.ts`, `packages/agents/src/approval-policy.ts`
_Depends:_ 21
_Requirements:_ 3.7, 5.3

- [x] 22.1 `apps/worker/src/stores.ts` の `createJobStore.insert` を冪等化する:
  `.onConflictDoNothing({ target: job.id })` を付与し、Inngest リプレイ(リトライ/レジューム)での
  再 insert を安全な no-op にする(DB 障害等の本物の失敗は従来通り fail-loud)。`main.ts` の
  該当コメントも冪等前提へ更新。**TDD**: `stores.spec.ts` に「insert が
  `onConflictDoNothing` を呼ぶ」冪等性テストを追加(RED→GREEN)。真の PK 衝突→no-op の
  挙動検証は live DB(Task 15)へ委譲(fake db は一意制約を強制しないため)。
  _Boundary:_ `apps/worker/src/stores.ts`, `apps/worker/src/main.ts`
  _Requirements:_ 3.7
- [x] 22.2 `packages/agents/src/chat-agent.ts` の `buildStreamTextOptions` に**リクエスト単位の
  sticky taint フラグ** `externallyDriven` を導入する。`buildPrepareStep` がコンテキストブロックを
  注入した瞬間にラッチし、区切り文字がメッセージ窓から消えた後もその実行の残り全ステップで
  外部駆動判定を維持する(R5.3)。フラグは `stream()` 毎の新規 closure でリクエスト間に漏れない。
  `packages/agents/src/approval-policy.ts` の `createToolApprovalPolicy` に**加算的**な
  `isExternallyDriven?` シグナルを追加(既定の delimiter スキャンと OR、`isDestructive` と同じ
  「制御を弱めない」契約 — `false` を返しても既定を抑制しない)。**TDD**: chat-agent に「検索後の
  後続ステップで区切り文字が無くても承認を強制する」テスト、approval-policy に加算的シグナルの
  2 テスト(true→強制／false→既定スキャン維持)を追加(RED→GREEN)。
  _Boundary:_ `packages/agents/src/chat-agent.ts`, `packages/agents/src/approval-policy.ts`
  _Requirements:_ 5.3

### Implementation Notes

- **22.1 完了**: `createJobStore.insert` に `.onConflictDoNothing({ target: job.id })`。ターゲットを
  `id` PK に限定し、将来の unique 制約衝突は黙殺しない。`main.ts` の insert 前コメントと
  `RunJobOptions.jobStore` doc を「replay で再実行されるため冪等」に更新。**残存**: 実 PK 衝突→
  no-op の統合検証は Task 15 の live DDL テストへ委譲(do.md に追跡記載)。
- **22.2 完了**: sticky taint(chat-agent)+ 加算的 `isExternallyDriven`(approval-policy)。
  1 巡目修正が置換意味論(`?? isExternallyDrivenTurn`)だった点を加算(`isExternallyDrivenTurn(msgs)
  || options.isExternallyDriven?.(msgs)`)へ是正し、防御を弱められない不変条件を復元。chat-agent
  側は `() => externallyDriven` へ簡素化(既定の再 OR 不要)。**境界**: `approval-policy.ts`
  (Task 19.2 所管)への追加は本 remediation で承認・記録(Task 21 と同じレビュー由来是正の前例)。
- **検証**: `mise run check` 全緑 — `lint`(133 files clean)、`typecheck`(全ワークスペース Done)、
  `test:run`(47 files / **392 passed**、22.1/22.2 の新規テスト 4 件を追加、既存回帰なし)。

---

## Coverage Matrix

| Requirement | Tasks |
|-------------|-------|
| 1.1 | 1.1, 1.2 |
| 1.2 | 1.1, 8.6 |
| 1.3 | 2.4, 5.1, 5.2, 5.3 |
| 1.4 | 2.4, 4.2, 4.3 |
| 1.5 | 6.1, 6.3 |
| 1.6 | 5.4 |
| 1.7 | 5.2, 6.2, 6.3, 7.2, 7.5 |
| 1.8 | 1.3, 3.2, 3.3, 7.4 |
| 1.9 | 1.3, 7.1, 7.2, 7.3 |
| 1.10 | 7.5 |
| 2.1 | 8.2, 9.2, 9.3 |
| 2.2 | 8.1, 8.3 |
| 2.3 | 8.3, 8.4, 8.5 |
| 2.4 | 9.1, 9.4, 9.6 |
| 2.5 | 10.1, 10.2 |
| 2.6 | 9.2, 9.5 |
| 2.7 | 9.3 |
| 3.1 | 13.1, 13.2, 13.5 |
| 3.2 | 11.1, 13.2, 14.1 |
| 3.3 | 11.2, 12.1 |
| 3.4 | 12.2, 12.3, 14.3, 14.5 |
| 3.5 | 13.6, 14.3 |
| 3.6 | 11.2, 13.3, 14.2, 14.4 |
| 3.7 | 13.6, 15.2 |
| 3.8 | 15.1 |
| 4.1 | 3.4, 6.4 |
| 4.2 | 13.2, 16.1, 21.5, 21.6 |
| 4.3 | 3.4 |
| 4.4 | 17.2, 17.3, 17.4 |
| 4.5 | 16.2, 17.3 |
| 4.6 | 17.5 |
| 4.7 | 2.4, 16.3 |
| 5.1 | 18.1, 18.2, 21.3, 21.4 |
| 5.2 | 19.1, 21.5 |
| 5.3 | 19.2, 21.5 |
| 5.4 | 19.3, 21.2 |
| 5.5 | 13.4, 20.1, 20.2, 20.3, 21.5 |
| NFR-1 | 1.2, 7.1, 7.5 |
| NFR-2 | 1.3 |
| NFR-3 | 2.2, 3.2, 8.4, 8.5 |
| NFR-4 | 3.4 |
| NFR-5 | 7.5 |
| NFR-6 | 2.1, 2.3 |
| NFR-7 | 3.4, 6.4 |

## Parallelization (waves)

`--sequential` 未指定。`(P)` は同一 wave 内で境界が互いに素なタスクにのみ付与。

- **Wave A（Phase 1）**: 1 → 2 → {3 (P) ∥ 4 (P)} → 5 → 6 → 7。Task 7 内は
  7.1/7.2/7.3/7.4 が並列可（7.5 が集約検証）。
- **Wave B（Phase 2/3/4 起点、Task 7 完了後）**: 8 (P) ∥ 11 (P) ∥ 16 (P)（境界が互いに素）。
  - Phase 2 系列: 8 → 9 → 10（Task 8 内 8.1/8.4/8.5/8.6 は並列可）。
  - Phase 3 系列: 11 → 12 → 13（9 も要）→ 14 → 15。
  - Phase 4 系列: 16 → 17（10 も要、Task 16 内 16.1/16.2 並列可）。
- **Wave C（Phase 5、Phase 3 完了後）**: 18 (P) ∥ 19 (P) ∥ 20 (P)（境界が互いに素、
  20.1 は 16.3 の後に `deps.ts` を編集）。
