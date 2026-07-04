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

- [ ] 4.1 `packages/tools/package.json` を作成し `@vaz/tools` として定義する。
  _Boundary:_ `packages/tools/package.json`
  _Depends:_ 2.1
  _Requirements:_ 1.4
- [ ] 4.2 `src/time.ts` に `createTimeCapability(deps)` を実装し、既存 `getCurrentTime`
  を deps closure 化する（`deps.now` を参照、unit-testable）。
  _Boundary:_ `packages/tools/src/time.ts`
  _Depends:_ 4.1, 2.4
  _Requirements:_ 1.4
- [ ] 4.3 `src/index.ts` で capability を集約 export する。
  _Boundary:_ `packages/tools/src/index.ts`
  _Depends:_ 4.2
  _Requirements:_ 1.4

### Implementation Notes

---

## 5. `@vaz/agents` エージェントコアと Mock 単体テスト

`createChatAgent(deps)` を提供し、現行 `streamText` を挙動等価で封じ込めたうえで
`MockLanguageModelV4` によりネットワークなしの単体テストを成立させる。

_Boundary:_ `packages/agents/package.json`, `packages/agents/src/chat-agent.ts`, `packages/agents/src/index.ts`, `packages/agents/tests/chat-agent.spec.ts`
_Depends:_ 3, 4
_Requirements:_ 1.3, 1.6, 1.7

- [ ] 5.1 `packages/agents/package.json` を作成し `@vaz/agents`（`@vaz/schemas`/`@vaz/config`/`@vaz/tools` 依存）として定義する。
  _Boundary:_ `packages/agents/package.json`
  _Depends:_ 3.1, 4.1
  _Requirements:_ 1.3
- [ ] 5.2 `src/chat-agent.ts` に `createChatAgent(deps)` を実装し、`resolveModel()` +
  tools + `stopWhen: isStepCount(n)` を内包する（まず現行挙動と等価に封じ込め、回帰緑後に `ToolLoopAgent` 化）。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 5.1, 2.4, 3.2, 4.3
  _Requirements:_ 1.3, 1.7
- [ ] 5.3 `src/index.ts` でエージェント公開 API（`createChatAgent`/`AgentDeps` 再 export）を定義する。
  _Boundary:_ `packages/agents/src/index.ts`
  _Depends:_ 5.2
  _Requirements:_ 1.3
- [ ] 5.4 `tests/chat-agent.spec.ts` を `MockLanguageModelV4`（`ai/test`）+ mock deps で
  記述し、LLM API 呼び出し・ネットワークなしでツール選択/ループ制御を検証する
  （Red-Green: 5.2 実装前に失敗テストとして先行作成し、失敗を確認してから 5.2 を実装する）。
  _Boundary:_ `packages/agents/tests/chat-agent.spec.ts`
  _Depends:_ 5.1
  _Requirements:_ 1.6

### Implementation Notes

---

## 6. `apps/web` への移設と薄いアダプタ化・OTel 起動

既存 Next.js アプリを `apps/web` へ移設し、`route.ts` を `@vaz/agents` への薄い
HTTP⇔Agent アダプタへ縮退、`instrumentation.ts` で OTel を Phase 1 から有効化する。

_Boundary:_ `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/features/chat/**`, `apps/web/src/assets/styles/global.scss`, `apps/web/src/app/api/chat/route.ts`, `apps/web/instrumentation.ts`
_Depends:_ 5
_Requirements:_ 1.5, 1.7, 4.1, NFR-7

- [ ] 6.1 `apps/web/package.json`（`@vaz/*` 依存）と `apps/web/tsconfig.json`
  （base 継承 + `@ → src` alias）を作成する。
  _Boundary:_ `apps/web/package.json`, `apps/web/tsconfig.json`
  _Depends:_ 5.3
  _Requirements:_ 1.5
- [ ] 6.2 `next.config.ts` / `layout.tsx` / `page.tsx` / `features/chat/**` /
  `global.scss` を `apps/web` へ移設する（`page.tsx` は Server Component 維持、React Compiler は web のみ、挙動等価）。
  _Boundary:_ `apps/web/next.config.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/features/chat/**`, `apps/web/src/assets/styles/global.scss`
  _Depends:_ 6.1
  _Requirements:_ 1.7
- [ ] 6.3 `src/app/api/chat/route.ts` を薄い HTTP⇔Agent アダプタへ縮退する
  （Zod 検証 → `createChatAgent(deps).stream()` → `toUIMessageStream` → `createUIMessageStreamResponse`、オーケストレーションは route に置かない）。
  _Boundary:_ `apps/web/src/app/api/chat/route.ts`
  _Depends:_ 6.1, 5.3
  _Requirements:_ 1.5, 1.7
- [ ] 6.4 `apps/web/instrumentation.ts` を作成し `registerOTel` + `initTelemetry()` を
  呼び、全 agent 呼び出しに OTel span を有効化する。
  _Boundary:_ `apps/web/instrumentation.ts`
  _Depends:_ 6.1, 3.4
  _Requirements:_ 4.1, NFR-7

### Implementation Notes

---

## 7. ワークスペース品質ゲート配線と Phase 1 回帰検証

Vitest projects / Playwright / git hooks / モデル ID 直書き検出をワークスペース対応へ
改修し、全ゲート緑かつ Phase 1 スコープ限定（RAG/WF 非混入）を検証する。

_Boundary:_ `vitest.config.ts`, `apps/web/vitest.config.ts`, `playwright.config.ts`, `.githooks/pre-commit`, `.githooks/pre-push`, `apps/web/tests/e2e/**`, `scripts/forbid-model-ids.sh`
_Depends:_ 6
_Requirements:_ 1.7, 1.8, 1.9, 1.10, NFR-1, NFR-5

- [ ] 7.1 (P) `vitest.config.ts` を Vitest projects（web=jsdom / node パッケージ=node）へ
  変更し、`apps/web/vitest.config.ts` を追加する。
  _Boundary:_ `vitest.config.ts`, `apps/web/vitest.config.ts`
  _Depends:_ 6.2
  _Requirements:_ 1.9, NFR-1
- [ ] 7.2 (P) `playwright.config.ts` の webServer を `--filter @vaz/web` へ切替え、既存 E2E を
  `apps/web/tests/e2e/**` へ移設する（回帰なし）。
  _Boundary:_ `playwright.config.ts`, `apps/web/tests/e2e/**`
  _Depends:_ 6.2
  _Requirements:_ 1.7, 1.9
- [ ] 7.3 (P) `.githooks/pre-commit`・`.githooks/pre-push` を `pnpm -r`/mise・`--filter @vaz/web`
  経由に更新する（biome + tsc + vitest + audit / pre-push E2E を維持）。
  _Boundary:_ `.githooks/pre-commit`, `.githooks/pre-push`
  _Depends:_ 6.2
  _Requirements:_ 1.9
- [ ] 7.4 (P) `scripts/forbid-model-ids.sh` を作成し、`@vaz/config` 外のモデル ID 直書きを
  grep で検出して lint ステージを失敗させる。
  _Boundary:_ `scripts/forbid-model-ids.sh`
  _Depends:_ 6.2
  _Requirements:_ 1.8
- [ ] 7.5 全ゲート（lint/typecheck/vitest/E2E/audit/model-id）を緑にし、`/api/chat` の
  Anthropic↔Ollama 切替が移行前と等価であること、RAG/WF が混入していないことを回帰検証する。
  _Boundary:_ `apps/web/tests/e2e/**`
  _Depends:_ 7.1, 7.2, 7.3, 7.4
  _Requirements:_ 1.10, NFR-1, NFR-5

### Implementation Notes

---

## 8. (P) RAG 永続化基盤とプロビジョニング（Phase 2）

PostgreSQL + pgvector を docker-compose でプロビジョニングし、Drizzle スキーマ・
埋め込み解決・env 拡張を用意する（埋め込み次元は DDL で固定）。

_Boundary:_ `docker-compose.yml`, `packages/rag/package.json`, `packages/rag/src/db/schema.ts`, `packages/config/src/embedding.ts`, `packages/schemas/src/env.ts`, `pnpm-workspace.yaml`
_Depends:_ 7
_Requirements:_ 1.2, 2.1, 2.2, 2.3

- [ ] 8.1 (P) `docker-compose.yml` に postgres+pgvector の開発サービスを定義する。
  _Boundary:_ `docker-compose.yml`
  _Depends:_ 7
  _Requirements:_ 2.2
- [ ] 8.2 `packages/rag/package.json` を作成し `@vaz/rag` として定義する。
  _Boundary:_ `packages/rag/package.json`
  _Depends:_ 7
  _Requirements:_ 2.1
- [ ] 8.3 `src/db/schema.ts` に Drizzle スキーマ（document/chunk/embedding、`drizzle-zod`、
  `vector(N)` は DDL 時に次元固定、`provider`/`dim` 列で混在検出）を定義する。
  _Boundary:_ `packages/rag/src/db/schema.ts`
  _Depends:_ 8.2
  _Requirements:_ 2.2, 2.3
- [ ] 8.4 (P) `packages/config/src/embedding.ts` に `resolveEmbeddingModel(env?)`
  （既定 Ollama `nomic-embed-text`、`embedMany` 経由）を実装する。
  _Boundary:_ `packages/config/src/embedding.ts`
  _Depends:_ 7
  _Requirements:_ 2.3
- [ ] 8.5 (P) `packages/schemas/src/env.ts` に `AI_EMBEDDING_PROVIDER` 等の
  埋め込みプロバイダ設定を追加し Zod で検証する。
  _Boundary:_ `packages/schemas/src/env.ts`
  _Depends:_ 7
  _Requirements:_ 2.3
- [ ] 8.6 (P) `pnpm-workspace.yaml` に `pg` 等の install script を `allowBuilds` へ
  監査追記する（default deny 方針を維持）。
  _Boundary:_ `pnpm-workspace.yaml`
  _Depends:_ 7
  _Requirements:_ 1.2

### Implementation Notes

---

## 9. RAG ingest / retrieve capability（Phase 2）

`ingest/`（loader→chunk→embed→upsert）と `retrieve/`（reranker なしのベクトル検索）を
実装し、`RetrievedChunk`/`Citation` 契約で retrieval を capability として export する。

_Boundary:_ `packages/schemas/src/rag.ts`, `packages/rag/src/ingest/index.ts`, `packages/rag/src/retrieve/index.ts`, `packages/rag/src/tools.ts`, `packages/rag/bin/ingest.ts`, `packages/agents/src/chat-agent.ts`
_Depends:_ 8
_Requirements:_ 2.1, 2.4, 2.6, 2.7

- [ ] 9.1 `packages/schemas/src/rag.ts` に `RetrievedChunk`/`Citation` 契約を定義する。
  _Boundary:_ `packages/schemas/src/rag.ts`
  _Depends:_ 8.3
  _Requirements:_ 2.4
- [ ] 9.2 `src/ingest/index.ts` に loader→chunk→embed→upsert パスを実装する
  （provider/dim 整合ガード付き）。
  _Boundary:_ `packages/rag/src/ingest/index.ts`
  _Depends:_ 8.3, 8.4, 9.1
  _Requirements:_ 2.1, 2.6
- [ ] 9.3 `src/retrieve/index.ts` に reranker なしのベクトル検索を実装する。
  _Boundary:_ `packages/rag/src/retrieve/index.ts`
  _Depends:_ 8.3, 9.1
  _Requirements:_ 2.1, 2.7
- [ ] 9.4 `src/tools.ts` に `createRetrievalCapability(deps)` を実装し、`RetrievedChunk`/`Citation`
  を返す検索ツールを export する（chat agent が引用付き回答に使用）。
  _Boundary:_ `packages/rag/src/tools.ts`
  _Depends:_ 9.3, 9.1
  _Requirements:_ 2.4
- [ ] 9.5 `bin/ingest.ts` に CLI エントリを実装し `pnpm --filter @vaz/rag ingest ./docs`
  で end-to-end 取り込みできるようにする。
  _Boundary:_ `packages/rag/bin/ingest.ts`
  _Depends:_ 9.2
  _Requirements:_ 2.6
- [ ] 9.6 `packages/agents/src/chat-agent.ts` を Modify し、`createChatAgent(deps)` が `deps` 経由で
  RAG retrieval capability（9.4）をツール登録して引用付き回答を生成できるようにする
  （Phase 1 の time ツールに追加、`RetrievedChunk`/`Citation` を回答へ反映、env/deps 駆動で後方互換）。
  _Boundary:_ `packages/agents/src/chat-agent.ts`
  _Depends:_ 9.4
  _Requirements:_ 2.4

### Implementation Notes

---

## 10. RAG `recall@k` ゴールデンセット評価（Phase 2）

20–50 件の質問→期待 docID のゴールデンセットを用意し、埋め込みのみ（LLM 非依存）の
`recall@k` テストを CI で走らせる。

_Boundary:_ `packages/rag/tests/fixtures/golden-set.json`, `packages/rag/tests/recall.spec.ts`
_Depends:_ 9
_Requirements:_ 2.5

- [ ] 10.1 `tests/fixtures/golden-set.json` に 20–50 件の質問→期待 document-ID ペアを作成する。
  _Boundary:_ `packages/rag/tests/fixtures/golden-set.json`
  _Depends:_ 9.2
  _Requirements:_ 2.5
- [ ] 10.2 `tests/recall.spec.ts` に `recall@k` テストを実装する（埋め込みのみ、CI で実行）。
  _Boundary:_ `packages/rag/tests/recall.spec.ts`
  _Depends:_ 10.1, 9.3
  _Requirements:_ 2.5

### Implementation Notes

---

## 11. (P) 耐久エンジンスパイクとワークフロー契約（Phase 3）

Inngest vs Temporal (TS SDK) をスパイクで比較確定し、supervisor→specialist の型付き
step I/O と `JobEvent` 判別共用体を `packages/schemas` に定義する。

_Boundary:_ `docs/spikes/phase3-durable-engine.md`, `packages/schemas/src/workflows.ts`
_Depends:_ 7
_Requirements:_ 3.2, 3.3, 3.6

- [ ] 11.1 `docs/spikes/phase3-durable-engine.md` に Inngest と Temporal (TS SDK) の
  実装比較（中断/再開・HITL・再起動跨ぎ）とエンジン確定結論を記録する。
  _Boundary:_ `docs/spikes/phase3-durable-engine.md`
  _Depends:_ 7
  _Requirements:_ 3.2
- [ ] 11.2 `packages/schemas/src/workflows.ts` に supervisor→specialist の step I/O
  Zod スキーマと `JobEvent` 判別共用体（step-start/tool-call/token/completion/error）を定義する。
  _Boundary:_ `packages/schemas/src/workflows.ts`
  _Depends:_ 7
  _Requirements:_ 3.3, 3.6

### Implementation Notes

---

## 12. supervisor と承認ポリシー（`@vaz/agents` / Phase 3）

supervisor による専門エージェントへの型付きディスパッチと、破壊的ツールを
`user-approval` 化する `toolApproval` ポリシーを実装する。

_Boundary:_ `packages/agents/src/supervisor.ts`, `packages/agents/src/approval-policy.ts`, `packages/tools/src/email.ts`
_Depends:_ 11
_Requirements:_ 3.3, 3.4

- [ ] 12.1 `src/supervisor.ts` に `createSupervisorWorkflow(deps)` を実装し、計画→
  専門エージェント（RAG research / document generation / data processing）へ workflow step として分配する。
  _Boundary:_ `packages/agents/src/supervisor.ts`
  _Depends:_ 11.2
  _Requirements:_ 3.3
- [ ] 12.2 `src/approval-policy.ts` に `toolApproval` ポリシーを実装し、破壊的ツール
  （`needsApproval`）でワークフローを中断させる。
  _Boundary:_ `packages/agents/src/approval-policy.ts`
  _Depends:_ 11.2
  _Requirements:_ 3.4
- [ ] 12.3 `packages/tools/src/email.ts` に代表的な破壊的ツール（外部送信）を
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

_Boundary:_ `apps/worker/package.json`, `apps/worker/src/main.ts`, `apps/worker/src/events.ts`, `apps/worker/src/audit.ts`, `apps/worker/Dockerfile`, `docker-compose.yml`
_Depends:_ 12, 9
_Requirements:_ 3.1, 3.2, 3.5, 3.6, 3.7, 4.2, 5.5

- [ ] 13.1 `apps/worker/package.json` を作成し `@vaz/worker`（`@vaz/agents`/`@vaz/rag` 依存、Node 24 常駐）として定義する。
  _Boundary:_ `apps/worker/package.json`
  _Depends:_ 12.1
  _Requirements:_ 3.1
- [ ] 13.2 `src/main.ts` にエンジンのワーカーエントリと step 実行を実装し、ジョブ投入
  （web）と実行（worker）を分離する。span に `jobId`/`userId`/agent 名を付与する。
  _Boundary:_ `apps/worker/src/main.ts`
  _Depends:_ 13.1, 11.2, 9.4
  _Requirements:_ 3.1, 3.2, 4.2
- [ ] 13.3 `src/events.ts` に進捗イベント永続化（DB/Redis pub/sub）を実装する。
  _Boundary:_ `apps/worker/src/events.ts`
  _Depends:_ 13.1, 11.2
  _Requirements:_ 3.6
- [ ] 13.4 `src/audit.ts` に worker 経路の `deps.audit` DB sink 実装を供給する（発火点は `@vaz/agents`）。
  _Boundary:_ `apps/worker/src/audit.ts`
  _Depends:_ 13.1
  _Requirements:_ 5.5
- [ ] 13.5 `Dockerfile`（`pnpm deploy`）を作成し、`docker-compose.yml` に worker/engine/redis サービスを追加する。
  _Boundary:_ `apps/worker/Dockerfile`, `docker-compose.yml`
  _Depends:_ 13.2
  _Requirements:_ 3.1
- [ ] 13.6 チェックポイントによる中断→再開と worker 再起動跨ぎ完走（10 分超ジョブ）を実装する。
  _Boundary:_ `apps/worker/src/main.ts`
  _Depends:_ 13.2
  _Requirements:_ 3.5, 3.7

### Implementation Notes

---

## 14. Web ジョブ API・SSE・承認 UI（Phase 3）

ジョブ投入・SSE 進捗配信・承認イベント受信の Route Handler と、`useJobStream` フック・
承認 UI を実装する。

_Boundary:_ `apps/web/src/app/api/jobs/route.ts`, `apps/web/src/app/api/jobs/[id]/stream/route.ts`, `apps/web/src/app/api/jobs/[id]/approve/route.ts`, `apps/web/src/features/jobs/useJobStream.ts`, `apps/web/src/features/jobs/ApprovalPanel.tsx`
_Depends:_ 13
_Requirements:_ 3.2, 3.4, 3.5, 3.6

- [ ] 14.1 `api/jobs/route.ts` に `POST /api/jobs`（workflow 種別 + 入力を Zod 検証 → engine 投入、`{ jobId }` を返す）を実装する。
  _Boundary:_ `apps/web/src/app/api/jobs/route.ts`
  _Depends:_ 11.2, 13.2
  _Requirements:_ 3.2
- [ ] 14.2 `api/jobs/[id]/stream/route.ts` に SSE Route Handler を実装し `JobEvent` 判別共用体を配信する。
  _Boundary:_ `apps/web/src/app/api/jobs/[id]/stream/route.ts`
  _Depends:_ 11.2, 13.3
  _Requirements:_ 3.6
- [ ] 14.3 `api/jobs/[id]/approve/route.ts` に承認イベント受信（`{ toolCallId, decision, args? }`）→中断中ワークフローへの再開シグナルを実装する。
  _Boundary:_ `apps/web/src/app/api/jobs/[id]/approve/route.ts`
  _Depends:_ 11.2
  _Requirements:_ 3.4, 3.5
- [ ] 14.4 `features/jobs/useJobStream.ts` に SSE 消費フックを実装する。
  _Boundary:_ `apps/web/src/features/jobs/useJobStream.ts`
  _Depends:_ 14.2
  _Requirements:_ 3.6
- [ ] 14.5 `features/jobs/ApprovalPanel.tsx` に承認 UI（approve/reject/edit args、`"use client"`）を実装する。
  _Boundary:_ `apps/web/src/features/jobs/ApprovalPanel.tsx`
  _Depends:_ 14.3
  _Requirements:_ 3.4

### Implementation Notes

---

## 15. 承認中断→再開の耐久性 E2E（Phase 3）

翌日承認→再開完走と、worker 再起動跨ぎ完走を E2E で検証する。

_Boundary:_ `apps/web/tests/e2e/approval-resume.spec.ts`
_Depends:_ 14
_Requirements:_ 3.7, 3.8

- [ ] 15.1 `tests/e2e/approval-resume.spec.ts` に「承認待ち中断→翌日承認→再開完走」の E2E を実装する。
  _Boundary:_ `apps/web/tests/e2e/approval-resume.spec.ts`
  _Depends:_ 14.5, 14.3
  _Requirements:_ 3.8
- [ ]* 15.2 同 spec に worker 再起動跨ぎでのジョブ完走 E2E を追加する（3.7 はコア実装 13.6 で充足済み、E2E は後回し可）。
  _Boundary:_ `apps/web/tests/e2e/approval-resume.spec.ts`
  _Depends:_ 15.1
  _Requirements:_ 3.7

### Implementation Notes

---

## 16. (P) テレメトリ拡充と評価契約（Phase 4）

span 属性の付与、`GradeReport` 契約、logger の PII 非記録明文化を行う。

_Boundary:_ `packages/config/src/telemetry.ts`, `packages/schemas/src/eval.ts`, `packages/schemas/src/deps.ts`
_Depends:_ 7
_Requirements:_ 4.2, 4.5, 4.7

- [ ] 16.1 (P) `packages/config/src/telemetry.ts` に span 属性 `jobId`/`userId`/agent 名を付与し、
  ワークフロー全体を単一トレースとして追跡可能にする（token/cost を Langfuse で可視化）。
  `jobId` は Phase 3 ジョブ経路で付与（同期チャットは null 可）、`userId` は認証確立（18.2, Phase 5）
  後に実値を付与し、それ以前は anonymous/省略とする。
  _Boundary:_ `packages/config/src/telemetry.ts`
  _Depends:_ 7（`userId` の実値付与は 18.2 後）
  _Requirements:_ 4.2
- [ ] 16.2 (P) `packages/schemas/src/eval.ts` に `GradeReport`（outcome と behavior を別軸）契約を定義する。
  _Boundary:_ `packages/schemas/src/eval.ts`
  _Depends:_ 7
  _Requirements:_ 4.5
- [ ] 16.3 `packages/schemas/src/deps.ts` の logger 契約に PII 非記録（INFO 既定 off、sensitive-payload は opt-in）を明文化する。
  _Boundary:_ `packages/schemas/src/deps.ts`
  _Depends:_ 7
  _Requirements:_ 4.7

### Implementation Notes

---

## 17. `@vaz/evals` 3 層評価ハーネスと nightly CI（Phase 4）

tier1 unit（MockModel）/ tier3 LLM-as-judge / nightly（コスト上限・退行検知）を実装する
（tier2 `recall@k` は Task 10 と共有）。

_Boundary:_ `packages/evals/package.json`, `packages/evals/src/unit/**`, `packages/evals/src/judge.ts`, `packages/evals/src/nightly.ts`, `.github/workflows/eval-nightly.yml`
_Depends:_ 16, 10
_Requirements:_ 4.4, 4.5, 4.6

- [ ] 17.1 `packages/evals/package.json` を作成し `@vaz/evals` として定義する。
  _Boundary:_ `packages/evals/package.json`
  _Depends:_ 16.2
  _Requirements:_ 4.4
- [ ] 17.2 `src/unit/*.spec.ts` に tier1 unit（MockModel：ツール選択・ループ制御・スキーマ適合、毎 CI）を実装する。
  _Boundary:_ `packages/evals/src/unit/**`
  _Depends:_ 17.1
  _Requirements:_ 4.4
- [ ] 17.3 `src/judge.ts` に tier3 LLM-as-judge（実モデル + evalite/promptfoo、`GradeReport` を生成）を実装する。
  _Boundary:_ `packages/evals/src/judge.ts`
  _Depends:_ 17.1, 16.2
  _Requirements:_ 4.4, 4.5
- [ ] 17.4 `src/nightly.ts` に nightly 実行 + コスト上限を実装し、結果を Langfuse へ記録する。
  _Boundary:_ `packages/evals/src/nightly.ts`
  _Depends:_ 17.3
  _Requirements:_ 4.4
- [ ] 17.5 `.github/workflows/eval-nightly.yml` に `eval:nightly`（GitHub Secrets ゲート・コスト上限・ゴールデンセット退行検知）を実装する。
  _Boundary:_ `.github/workflows/eval-nightly.yml`
  _Depends:_ 17.4
  _Requirements:_ 4.6

### Implementation Notes

---

## 18. (P) 認証と権限スコープ（Phase 5）

社内 IdP OIDC 連携方式を確定し、認証セッションからツール実行を `runtimeContext` の
ユーザー権限にスコープする。

_Boundary:_ `docs/spikes/phase5-idp.md`, `apps/web/src/lib/auth.ts`
_Depends:_ 14
_Requirements:_ 5.1

- [ ] 18.1 `docs/spikes/phase5-idp.md` に IdP 連携方式（Auth.js / 社内標準、Entra ID / Google Workspace）の確定結論を記録する。
  _Boundary:_ `docs/spikes/phase5-idp.md`
  _Depends:_ 14
  _Requirements:_ 5.1
- [ ] 18.2 `apps/web/src/lib/auth.ts` に OIDC 認証を実装し、セッション権限を `runtimeContext`
  （`{ userId, role }`）へマップして tool 実行を deps 経由でスコープする。
  _Boundary:_ `apps/web/src/lib/auth.ts`
  _Depends:_ 18.1
  _Requirements:_ 5.1

### Implementation Notes

---

## 19. (P) プロンプトインジェクション防御と破壊的ツール抑止（Phase 5）

RAG 結果を区切りコンテキストとして隔離し、外部読取駆動時に破壊的ツールを無効/HITL 化、
外部送信ツールに宛先許可リストを強制する（lethal trifecta / Rule of Two）。

_Boundary:_ `packages/agents/src/prompt.ts`, `packages/agents/src/approval-policy.ts`, `packages/tools/src/allowlist.ts`
_Depends:_ 12, 9
_Requirements:_ 5.2, 5.3, 5.4

- [ ] 19.1 `packages/agents/src/prompt.ts` に RAG 結果を明示区切りのコンテキストブロックとして
  注入する（system プロンプトへ混合しない、untrusted 前提）。
  _Boundary:_ `packages/agents/src/prompt.ts`
  _Depends:_ 12.1, 9.4
  _Requirements:_ 5.2
- [ ] 19.2 `packages/agents/src/approval-policy.ts` を拡張し、外部読取駆動ターン（RAG 結果等）で
  破壊的ツールを無効化 or HITL 承認必須にする。
  _Boundary:_ `packages/agents/src/approval-policy.ts`
  _Depends:_ 12.2
  _Requirements:_ 5.3
- [ ] 19.3 `packages/tools/src/allowlist.ts` に外部送信ツール（email 等）の宛先許可リスト強制を実装する。
  _Boundary:_ `packages/tools/src/allowlist.ts`
  _Depends:_ 12.2
  _Requirements:_ 5.4

### Implementation Notes

---

## 20. (P) ツール実行監査ログ（Phase 5）

`AgentDeps.audit` sink 契約を確定し、agent lifecycle で全ツール実行を発火、web/worker
双方の DB sink で永続化する（発火点は `@vaz/agents` 単一箇所）。

_Boundary:_ `packages/schemas/src/deps.ts`, `packages/agents/src/audit-hook.ts`, `apps/web/src/lib/audit.ts`
_Depends:_ 12, 14, 16
_Requirements:_ 5.5

- [ ] 20.1 `packages/schemas/src/deps.ts` の `AgentDeps.audit` sink 契約と `AuditEntrySchema`
  （who/job/tool/args）を確定する（Phase 1 は no-op 許容）。
  _Boundary:_ `packages/schemas/src/deps.ts`
  _Depends:_ 12.1, 16.3
  _Requirements:_ 5.5
- [ ] 20.2 `packages/agents/src/audit-hook.ts` を作成し、agent ループの lifecycle で全ツール
  呼び出しを `deps.audit` へ発火する（web/worker 共通発火点）。
  _Boundary:_ `packages/agents/src/audit-hook.ts`
  _Depends:_ 20.1
  _Requirements:_ 5.5
- [ ] 20.3 `apps/web/src/lib/audit.ts` に web 経路の `deps.audit` DB sink 実装を供給する。
  _Boundary:_ `apps/web/src/lib/audit.ts`
  _Depends:_ 20.1, 14.1
  _Requirements:_ 5.5

### Implementation Notes

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
| 4.2 | 13.2, 16.1 |
| 4.3 | 3.4 |
| 4.4 | 17.2, 17.3, 17.4 |
| 4.5 | 16.2, 17.3 |
| 4.6 | 17.5 |
| 4.7 | 2.4, 16.3 |
| 5.1 | 18.1, 18.2 |
| 5.2 | 19.1 |
| 5.3 | 19.2 |
| 5.4 | 19.3 |
| 5.5 | 13.4, 20.1, 20.2, 20.3 |
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
