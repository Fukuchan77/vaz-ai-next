# 001-vaz-ai-update — PDCA Do Phase Log

実装の実行ログ。タスクごとに「実施内容 / 検証エビデンス / 学び」を追記する。
散文は日本語、識別子・パス・コマンドは英語。

---

## Task 1.1 — `pnpm-workspace.yaml` にワークスペース glob を追加

- **日時**: 2026-07-04
- **Requirements**: 1.1, 1.2
- **Boundary**: `pnpm-workspace.yaml`（単一ファイル、境界厳守）

### 実施内容

- 先頭コメント（旧「単一パッケージのため packages は定義しない」）をモノレポ前提へ更新。
- `packages:` に `apps/*` / `packages/*` を追加（R1.1）。
- `minimumReleaseAge` / `overrides` / `allowBuilds`（default deny）は無変更で維持（R1.2）。

### TDD 判断

- 本タスクは `src/` のユニットロジックではなくワークスペース設定 YAML のため、
  Red-Green-Refactor（失敗テスト先行）は非適用（tasks.md テスト規約に準拠）。
- 代わりに Verification Gate として「サプライチェーン節の byte-identical 証明」＋
  「pnpm によるワークスペース解決」を実施。

### 検証エビデンス（Verification Gate）

- **R1.2 サプライチェーン維持**: `minimumReleaseAge` 以降を HEAD と `diff` → `IDENTICAL`。
  ```
  diff <(git show HEAD:pnpm-workspace.yaml | sed -n '/^minimumReleaseAge:/,$p') \
       <(sed -n '/^minimumReleaseAge:/,$p' pnpm-workspace.yaml)   # → 差分なし
  ```
- **R1.1 glob 追加**: `grep -nE '^\s+- "(apps|packages)/\*"'` → `apps/*`, `packages/*` 検出。
- **ワークスペース解決**: `pnpm ls -r --depth -1` → exit 0
  （`vaz-ai-next@1.0.0 ... (PRIVATE)`、空 glob でもエラーなし）。
- **git diff**: 追加行（header 差替え + `packages:` ブロック）のみ。
  サプライチェーン行の変更・削除ゼロ。

### 学び

- pnpm は `packages:` の glob がまだ 0 件マッチでもエラーにならない（メンバー追加前から
  安全に配線できる）。→ 後続 1.2〜6.x でパッケージを段階追加する順序が成立する。
- Biome は YAML を対象外のため、本編集は lint フォーマット影響なし。

---

## Task 1.2 — root tsconfig を references ソリューション化 + 共有 base 新設

- **日時**: 2026-07-04
- **Requirements**: 1.1, NFR-1
- **Boundary**: `tsconfig.json`, `packages/config/tsconfig.base.json`

### 実施内容

- `packages/config/tsconfig.base.json` を新設。framework-agnostic な strict 共有 base
  （target/module/moduleResolution/strict 系 + `verbatimModuleSyntax` 等）。
  DOM lib・jsx・Next plugin・React Compiler は**含めない**（適用境界 = apps/web）。
- root `tsconfig.json` を base 継承のソリューションルートへ変更。Next/React 固有
  （DOM lib・`jsx: react-jsx`・`@/*` alias・next plugin・allowJs/esModuleInterop/
  resolveJsonModule）のみを上書き。現行アプリは Phase 1 移行中 `./src` を include し続ける
  （Task 6 で apps/web へ移設するまで build/typecheck/E2E を緑維持 = NFR-1）。

### TDD 判断

- 対象は tsconfig（`src/` ユニットロジックでない）ため Red-Green-Refactor 非適用。
  Verification Gate（typecheck / vitest / base 継承証明 / build 回帰有無）で担保。

### エラーと根本原因（error-handling 準拠）

1. **TS6053 (references が存在しない参照先)**: 初版で `references` に apps/web・packages/*
   を列挙 → `tsc --noEmit`(非 build)でも TS6053 で失敗。
   - 根本原因: 参照先メンバーは後続タスクで実体化するため 1.2 時点で不在。tsc は非 build でも
     参照先の実在を要求する。
   - 対処: `references: []` に是正。Phase 1 のパッケージ横断型チェックは `pnpm -r typecheck`
     （Task 1.3 で配線）が担う設計とし、コメントに明記。
2. **`next build` 失敗 (`useContext` null / `/_not-found` prerender)**:
   - 根本原因調査: `git stash -u` で HEAD 純正状態を build → **同一エラーで失敗**
     （baseline-build-exit=1）。→ Task 1.2 起因ではない**既存不具合**（Next 16 + React 19.2 の
     `/_not-found` 静的 prerender 問題）と確定。tsconfig 変更は `--showConfig` 上も挙動中立。
   - 対処: 本タスクのスコープ外（回帰なし）。別途 flag（下記）として記録。

### 検証エビデンス（Verification Gate）

- **typecheck**: `mise run typecheck` → **exit 0 / error TS 0 件**。
- **base 継承証明**: `tsc -p tsconfig.json --showConfig` →
  `strict:true, target:es2022, lib:[es2022,dom,dom.iterable], jsx:react-jsx, verbatimModuleSyntax:true`
  （base 由来 + root 上書きが合成）。
- **unit tests**: `mise run test:run` → **exit 0 / 3 files・17 tests passed**（回帰なし）。
- **build 回帰判定**: 変更後・HEAD 純正の双方が同一 prerender エラーで失敗 →
  Task 1.2 による回帰は**なし**。pre-commit フック（biome+tsc+vitest+audit）に build は
  含まれず標準ゲートはブロックされない。

### 学び / Act 申し送り

- root tsconfig は本タスクのみが編集境界。`references` を後で埋めるには root 再編集が必要だが
  boundary 外 → Phase 1 は `pnpm -r` 集約型チェックで運用（`tsc -b` オーケストレーションは
  将来 root 再編集タスクで検討）。
- **[FLAG] 既存 build 不具合**: `next build` が `/_not-found` prerender で `useContext` null。
  HEAD から存在。Phase 1 の回帰基準は typecheck+vitest+E2E（build 非依存）だが、Task 7.5 の
  全ゲート緑化までに要トリアージ（Next/React/Carbon prerender 相性）。

---

## Task 1.3 — mise.toml をワークスペース対応化 + model-id ゲート + 集約 check

- **日時**: 2026-07-04
- **Requirements**: 1.8, 1.9, NFR-2
- **Boundary**: `mise.toml`

### 実施内容

- Web 固有タスク（`dev`/`build`/`start`）を `pnpm --filter @vaz/web exec next …` へ変更（モノレポ最終形）。
- `typecheck` をワークスペース対応化: `pnpm -r run typecheck`（メンバー）+ `[ -d src ]` ガード付き
  root `tsc --noEmit`（app が root 在中の間のみ）。
- `lint:model-ids` を追加。`scripts/forbid-model-ids.sh`（Task 7.4）が未作成の間は skip 通知、
  作成後は自動 enforce（R1.8）。
- `audit` タスクと集約 `check`（`depends = [lint, typecheck, test:run, audit, lint:model-ids]`）を追加。
  これが NFR-2 の `git clone → pnpm install → mise run check` エントリ。

### TDD 判断

- 対象は mise.toml 設定のため Red-Green-Refactor 非適用。Verification Gate で担保。

### 事前検証（設計を確定するための挙動確認）

- `pnpm -r run typecheck`（メンバー 0 件）→ "No projects matched" だが **exit 0**（no-op）。
- `pnpm --filter @vaz/web …`（不一致）→ 同様に **exit 0**。
  → 移行期にフィルタ系タスクが破綻しないことを確認し、`--filter`/`-r` 形を最終形として採用。
- 教訓: `cmd | head` 後の `$?` は head の終了コード。真の exit は `> log 2>&1; echo $?` で採取。

### 検証エビデンス（Verification Gate）

- **guarded tsc 実行確認**: `mise run typecheck` ログに
  `[typecheck] $ if [ -d src ]; then pnpm exec tsc --noEmit; …` を確認（root app を実検査）。
- **typecheck**: `mise run typecheck` → **exit 0 / error TS 0**。
- **lint:model-ids**: → **exit 0**、`scripts/forbid-model-ids.sh 未作成(Task 7.4)— skip` 通知。
- **集約 check（NFR-2）**: `mise run check` → **exit 0**（depends は fail-fast のため全緑を含意）。
  - `[lint] Checked 22 files … No fixes applied.`
  - `[test:run] Test Files 3 passed (3) / Tests 17 passed (17)`
  - `[audit] No known vulnerabilities found`

### 学び / Act 申し送り

- root tsconfig(1.2)・mise.toml(1.3) は Phase で各 1 編集境界。前方互換のため、不一致 no-op(exit 0)
  と `[ -d src ]` ガードで「移行期／移設後」両対応を吸収。後続で再編集不要。
- git hooks の mise 化は Task 7.3。それまで自動ゲートは `pnpm exec` 直呼びのまま（root app を継続被覆）。
- major Task 1（ワークスペース基盤）完了。次は Task 2（`@vaz/schemas`）。

---

## Task 2.1 — `@vaz/schemas` パッケージ定義（package.json）

_実施: 2026-07-04 / Boundary: `packages/schemas/package.json` / Requirements: NFR-6_

### 設計判断

- **source-only(JIT) パッケージ**: File Structure Plan に per-package `tsconfig.json` 非掲載 →
  ビルド無し・`.ts` を直 export し consumers(apps/web + root solution)が transitive に型検査。
- **subpath exports**: schemas に `index.ts` タスクが無い（tools=4.3 / agents=5.3 は有り）ため
  barrel ではなく `exports: { "./*": "./src/*.ts" }`。`@vaz/schemas/env` 等で import。
  wildcard により 2.2–2.4 + Phase 2+（rag/workflows/eval）追加時も本境界の再編集不要。
- `type: module` / `private: true` / `sideEffects: false` / `dependencies.zod ^4.4.3`。

### TDD 判断

- 対象は package.json 設定のため Red-Green-Refactor 非適用。Verification Gate で担保。

### エラー → 根本原因 → 修正（必須記録）

- **事象**: `@vaz/schemas` 追加後、`mise run typecheck` が
  `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`(exit 1) で赤化。
- **根本原因**: `pnpm -r run typecheck` の「不一致時 exit 0」（Task 1.3 do.md 記載）は
  **メンバー 0 件時のみ**成立。最初のメンバー追加で「メンバー ≥1・該当 script 0」となり pnpm が
  エラー。array step の 1 段目失敗で 2 段目(guarded root tsc)も未実行。
- **修正（在境界）**: mise.toml は凍結境界(1.3)・per-package tsconfig は作成不可のため、
  `@vaz/schemas` package.json に `typecheck` script を追加（凍結 mise 不変条件が本来要求する形）。
  standalone `tsc` は tsconfig 不在で root config へ誤解決するため不可 → transitive 検査方針を明示する
  echo marker を採用。blind retry ではなく根本原因特定後の設計整合修正。

### 検証エビデンス（Verification Gate）

- **install**: `pnpm install` → `Scope: all 2 workspace projects` / `@vaz/schemas@1.0.0 …(PRIVATE)` 解決。
- **lint**: `mise run lint` → `Checked 23 files … No fixes applied.`（exit 0）
- **typecheck**: `mise run typecheck` → **exit 0**。`pnpm -r run typecheck` が schemas の echo を実行後、
  guarded root `tsc --noEmit`（root app 実検査）へ継続。
- **test:run**: `Test Files 3 passed (3) / Tests 17 passed (17)`（既存回帰無し）。
- **集約 check（NFR-2）**: `mise run check` → **exit 0**。
  - `[audit] No known vulnerabilities found`
  - `[lint:model-ids] … 未作成(Task 7.4)— skip`
- build は既存 [FLAG]（`/_not-found` prerender、HEAD 由来）につき本タスク非対象・Task 7.5 でトリアージ。

### 学び / Act 申し送り

- **不変条件**: 凍結 mise の `pnpm -r run typecheck` を緑に保つには、全 source-only メンバーが
  `typecheck` script を持つ必要がある。**後続 3.1 / 4.1 / 5.1 の package.json も同 script 必須**。
- Task 2.1 完了。次は 2.2/2.3/2.4（(P) 並列可、env/chat/deps 移設）。

---

## Task 2.2 — `aiEnvSchema`/`parseAiEnv` を `@vaz/schemas` へ移設

_実施: 2026-07-04 / Boundary: `packages/schemas/src/env.ts` / Requirements: NFR-3_

### 設計判断 / TDD 判断

- **挙動等価な relocation**: `src/lib/ai/env.ts` を verbatim 複製（tabs 整形のみ差分、`diff -w` 一致）。
  `emptyToUndefined` 正規化・`.default()` を維持。
- **test-first は既存契約で充足**: `tests/provider.spec.ts::describe("parseAiEnv")` が defaults /
  空文字正規化 / 不正 provider / 不正 URL を既に pin（本 relocation 以前から緑）。schemas に test
  ファイル境界は無い（File Structure Plan Phase 1 は `packages/agents/tests/chat-agent.spec.ts` のみ）
  ため新規テストは追加しない（MANDATORY plan 非掲載パスは作成不可）。
- **旧ファイル非削除**: `src/lib/ai/provider.ts`(`./env`)・`tests/provider.spec.ts` が現用。消費側再配線
  （3.2 provider 移設 / 6 app 移設）まで temporary duplication で両緑を保つ。

### エラー → 根本原因 → 修正（必須記録）

- **事象1**: 新 env.ts は未 import のためゲート typecheck 非被覆（schemas は echo）。分離検証で
  `tsc … packages/schemas/src/env.ts` → **TS5112**（files 指定時 tsconfig.json と競合、TS6 挙動）。
  → **修正**: `--ignoreConfig` 付与。
- **事象2**: `--ignoreConfig` 後 **TS2591 `process` 未定義**（ambient `@types/node` が外れた）。
  → **修正**: `--types node` 付与。false negative（本体は project 内で `process.env` を同様に使用し緑）。
  最終: `tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler
  --verbatimModuleSyntax --isolatedModules --skipLibCheck --moduleDetection force --types node
  packages/schemas/src/env.ts` → **exit 0**。

### 検証エビデンス（Verification Gate）

- **behavior diff**: `diff -w src/lib/ai/env.ts packages/schemas/src/env.ts` → IDENTICAL。
- **isolated tsc**: exit 0（env.ts 単体コンパイル、node types 解決）。
- **集約 check（NFR-2）**: `mise run check` → **exit 0**。
  - `[lint] Checked 24 files … No fixes applied.`（+1 = 新 env.ts）
  - `[test:run] Test Files 3 passed (3) / Tests 17 passed (17)`（parseAiEnv 契約 緑・回帰無し）
  - `[audit] No known vulnerabilities found`
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 でトリアージ。

### 学び / Act 申し送り

- **[FLAG] R1.8 × env.ts 既定モデル ID**: env.ts は `"claude-opus-4-8"`/`"llama3.2"` を保持。2.2 の
  Requirements=NFR-3 のみ・「移設」指示に忠実な結果だが、R1.8 は model-allowlist(3.3)を唯一の合法
  直書き箇所と規定。`@vaz/schemas` は leaf で `@vaz/config` を import 不可。**7.4 の
  `forbid-model-ids.sh` は env.ts の schema `.default()` を除外するか、3.2/3.3 で resolveModel が
  allowlist から default 供給する形へ寄せること**。7.5 全ゲート緑化前に要トリアージ。
- 未 import の schemas src は現状ゲート typecheck 非被覆。consumers 配線（3.2/6）で transitive 被覆、
  最終被覆は 7.5。移設途中は「分離 tsc + 既存契約テスト + diff」で担保する運用を確立。
- Task 2.2 完了。次は 2.3（chat.ts）/ 2.4（deps.ts）。

---

## Task 2.3 — `chatRequestSchema` を `@vaz/schemas` へ移設

_実施: 2026-07-04 / Boundary: `packages/schemas/src/chat.ts` / Requirements: NFR-6_

### 設計判断 / TDD 判断

- 2.2 と同一パターンの挙動等価 relocation。`src/lib/ai/chat-schema.ts` を verbatim 複製（`diff -w` 一致）。
- **test-first は既存契約で充足**: `tests/chat-schema.spec.ts`（6 ケース）が UIMessage 形状・
  `looseObject` 透過・空配列/不正 role/type 欠落/messages 欠落の拒否を pin（relocation 以前から緑）。
  schemas に test 境界は無い（plan 非掲載）ため新規テスト非追加。
- **旧ファイル非削除**: `src/app/api/chat/route.ts`(`@/lib/ai/chat-schema`) が現用 → app 移設（6）まで
  temporary duplication で両緑。
- **model ID 非含** → R1.8 懸念なし（2.2 の [FLAG] とは無関係）。

### 検証エビデンス（Verification Gate）

- **behavior diff**: `diff -w src/lib/ai/chat-schema.ts packages/schemas/src/chat.ts` → IDENTICAL。
- **isolated tsc**: `tsc --ignoreConfig --noEmit --strict … packages/schemas/src/chat.ts` → **exit 0**
  （`process` 不使用のため `--types node` 不要）。
- **集約 check（NFR-2）**: `mise run check` → **exit 0**。
  - `[test:run] Test Files 3 passed (3) / Tests 17 passed (17)`（chatRequestSchema 契約 緑・回帰無し）
  - `[audit] No known vulnerabilities found`
- build は既存 [FLAG] につき非対象・7.5 でトリアージ。

### 学び / Act 申し送り

- 2.2 で確立した「verbatim 複製 + 分離 tsc + 既存契約テスト + `diff -w`」運用が model-ID 非含ケースでも
  そのまま機能。schemas 移設の反復手順として定着。
- Task 2.3 完了。Task 2 残り 1 件（2.4 `deps.ts`＝`AgentDeps` 型 + logger 契約、既存元ファイル無しの
  新規定義のため 2.2/2.3 とは性質が異なる点に注意）。

---

## Task 2.4 — `AgentDeps` 型 + logger / audit 契約を新規定義

_実施: 2026-07-04 / Boundary: `packages/schemas/src/deps.ts` / Requirements: 1.3, 1.4, 4.7_

### 設計判断

- **既存元無しの新規契約**（2.2/2.3 の relocation と異なる）。関数（logger メソッド・`now`）を含むため
  Zod 非適用 → **pure TS 型**で定義（schemas は Zod スキーマ + 契約/推論型の双方を持つ）。
- 定義: `Logger`(debug/info/warn/error + `LogFields`) / `Clock = () => Date`(R1.4) /
  `AuditEntry`(userId/jobId/tool/args/ts、userId・jobId null 可) + `AuditSink`(R5.5) /
  `AgentDeps<DB = unknown>` { db, logger, now, audit? }(R1.3)。
- **R4.7**: logger の PII 非記録は JSDoc 契約として明記（INFO 以下で raw prompt/tool I/O を既定非記録、
  opt-in は 16.3 で明文化）。型レベルでは強制せず behavioral contract として記述。
- **前方互換の判断**: (a) `db` generic 既定 unknown — 具体 client(Drizzle)は leaf schemas から import
  不可 & deps.ts は Phase 2 非編集 → generic で RAG が `AgentDeps<PostgresJsDatabase>` を narrow 可能。
  (b) `audit?` optional=省略で no-op(Phase 1 許容、20.1 で `AuditEntrySchema` 確定)。
  (c) `runtimeContext`(userId/role) は Phase 5(18.2) スコープのため非定義（スコープ厳守）。

### TDD（型のみモジュール）

- 実行時ロジック無し → runtime unit test 不成立。**ephemeral type-probe** による型レベル TDD:
  - **RED**: `src/__deps_probe.ts`(consumer 想定 usage: `deps.now()`/`AgentDeps<FakeDb>`/`AuditSink` 実装/
    `logger.info(msg, fields)`) を deps.ts 作成前に tsc → **TS2307 `Cannot find module './deps'`**。
  - **GREEN**: deps.ts 作成後、同 probe tsc → **exit 0**（契約が consumer usage で型検査を通る）。
  - probe は検証後に削除（コミットしない。schemas に test 境界は plan 非掲載）。

### 検証エビデンス（Verification Gate）

- **RED**: probe tsc → `TS2307 Cannot find module './deps'`（exit 非0）。
- **GREEN**: probe tsc → exit 0 / deps.ts 単体 tsc → exit 0（`--ignoreConfig … --moduleResolution bundler`）。
- **集約 check（NFR-2）**: `mise run check` → **exit 0**。
  - `[lint] Checked 26 files … No fixes applied.`（probe 削除後、+2 = chat.ts/deps.ts 反映）
  - `[test:run] Test Files 3 passed (3) / Tests 17 passed (17)`（回帰無し）
  - `[audit] No known vulnerabilities found`
- build は既存 [FLAG] につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **[修正] tasks.md 構造復旧**: 2.2 の Note 追記時に Task 2 の `---` 区切りと `## 3.` 見出しマーカーを
  誤って消していた（`## 3.` が bullet 行に merge）。2.4 で `- **2.4 完了**` 追記と同時に区切り/見出しを
  復旧（`grep '^## '` で全見出し健在を確認）。教訓: セクション末尾に追記する Edit は old_string に
  次見出しを含めない（含めると再付与漏れで構造破壊）。
- **Task 2 完了**: `@vaz/schemas` 単一正本(NFR-6) Phase 1 分(env/chat/deps)確立。型のみモジュールの
  検証パターン（ephemeral type-probe RED→GREEN→削除）を確立。次は Task 3（`@vaz/config`：3.1 package.json
  → 3.2 provider 移設 → 3.3 model-allowlist → 3.4 telemetry）。3.x で schemas consumers が初配線され、
  2.2 の [FLAG] R1.8（env.ts 既定モデル ID）の設計整合が現実の論点になる。

---

## Task 3.1 — `packages/config/package.json` 作成（`@vaz/config` 定義）

- **日時**: 2026-07-04
- **Requirements**: 1.8
- **Boundary**: `packages/config/package.json`（単一ファイル、境界厳守）

### 実施内容

- `@vaz/schemas`(2.1)と同型の source-only(JIT)パッケージとして定義:
  `type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }` wildcard /
  `typecheck` echo marker（凍結 mise の `pnpm -r run typecheck` 不変条件、2.1 Note 指示に準拠）。
- `dependencies` を R1.8（モデル解決）スコープで前方宣言:
  `@vaz/schemas`(`workspace:*`) + `ai` / `@ai-sdk/anthropic` / `@ai-sdk/openai-compatible`
  （現行 `src/lib/ai/provider.ts` の resolveModel 実体、いずれも root 既存＝install リスクなし）。
  → 3.2/3.3/3.4 は `src/*.ts` のみが境界で package.json 再編集不可のため、2.1(zod)と同じ
  「単一編集境界の前方宣言」を適用。

### TDD 判断

- `src/` のユニットロジックではなくパッケージ定義（package.json）のため
  Red-Green-Refactor（失敗テスト先行）は非適用（tasks.md テスト規約 / 2.1 と同一）。
- 代替 Verification Gate: JSON 妥当性 + ワークスペース解決 + 凍結 mise 不変条件 + 回帰。

### 検証エビデンス（Verification Gate）

- **valid JSON**: `node -e "JSON.parse(...)"` → `OK`。
- **workspace 認識**: `pnpm ls -r --depth -1` → `@vaz/config@1.0.0 … (PRIVATE)` 検出（exit 0）。
- **frozen install（lockfile 整合）**: `pnpm install --frozen-lockfile` → **exit 0**
  `Scope: all 3 workspace projects` / `Already up to date`（`workspace:*` リンクが lockfile
  churn ゼロで解決＝新規 install 不要）。
- **typecheck（凍結 mise 不変条件）**: `mise run typecheck` → **exit 0**
  （`packages/config typecheck: Done` + root `./src` tsc も緑）。
- **lint**: `biome check packages/config/package.json` → `Checked 1 file … No fixes applied.`（tab / 整形準拠）。
- **回帰**: `pnpm exec vitest run` → **exit 0** / `Tests 17 passed (17)`。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **[FLAG] telemetry 依存の未宣言（3.4 要トリアージ）**: `@ai-sdk/otel` / Langfuse OTLP exporter は
  root/lockfile 未導入の新規外部依存。宣言すると `minimumReleaseAge: 1440`・`allowBuilds`(default deny)
  の supply-chain ゲート判断を要する（=telemetry タスク 3.4 の責務）ため 3.1 では意図的に非宣言とした。
  package.json は単一編集境界のため 3.4 が config/package.json へ追加できない矛盾がある。3.4 の解決策:
  telemetry 依存を root package.json（移行期の dep home、hoisting で config から解決可）へ導入するか、
  3.4 の編集境界に config/package.json を含める。詳細は tasks.md Task 3 Implementation Notes 参照。
- **次**: 3.2（provider 移設：`resolveModel(env?)` を `@vaz/schemas/env#parseAiEnv` 経由で env 駆動化、
  直書きなし）→ 3.3（model-allowlist：R1.8 唯一の合法直書き箇所）→ 3.4（telemetry、上記 FLAG 解決）。
  3.2 実装時に 2.2 の [FLAG] R1.8（env.ts 既定モデル ID vs config allowlist）の設計整合を判断する。

---

## Task 3.2 — `packages/config/src/provider.ts`（`resolveModel` 移設・env 駆動）

- **日時**: 2026-07-04
- **Requirements**: 1.8, NFR-3
- **Boundary**: `packages/config/src/provider.ts`（単一ファイル、境界厳守）

### 実施内容

- `src/lib/ai/provider.ts` の `resolveModel(env?)` を挙動等価で移設。差分は import 元のみ
  （`./env` → `@vaz/schemas/env`）+ doc コメント追記。switch/return ロジックは byte-identical。
- R1.8/NFR-3「直書きなし」: provider に model ID を持たず `@vaz/schemas/env#parseAiEnv` 経由で
  env 駆動解決（`name: "ollama"` は provider 名でモデル ID ではない）。
- 旧 `src/lib/ai/provider.ts` は route.ts・`tests/provider.spec.ts` が現用のため非削除
  （app 移設 = Task 6 まで temporary duplication）。
- allowlist（3.3）統合は 3.2 非スコープ（3.2 は 3.3 非依存、指示は parseAiEnv 経由のみ）。

### TDD 判断（no-test-boundary migration）

- `@vaz/config` に test ファイル境界は無い（File Structure Plan 非掲載）ため 2.2/2.3 と同じ
  ephemeral type-probe パターンを適用。既存 `tests/provider.spec.ts` が behavior 契約として旧 module を
  ガード（回帰）。

### 検証エビデンス（Verification Gate）

- **RED**: probe（`import { resolveModel } from "./provider"`）に isolated tsc →
  `packages/config/src/__probe.ts(3,30): error TS2307: Cannot find module './provider'`（exit 2）。
- **GREEN**: provider.ts 作成後、probe / standalone とも isolated tsc → **exit 0**
  （`--ignoreConfig --moduleResolution bundler --types node`、`@vaz/schemas/env` subpath 解決）。probe 削除。
- **挙動等価**: `diff`（旧 provider の `./env` を `@vaz/schemas/env` へ置換して比較）→ switch/return
  ロジック一致（差分は import 順序 + doc コメントのみ）。
- **biome**: `biome check packages/config/src/provider.ts` → `Checked 1 file … No fixes applied.`
  （tab / double-quote / import 順序 / `import type` 準拠、canonical と一致）。
- **typecheck**: `mise run typecheck` → **exit 0**（`packages/config typecheck: Done` + root `./src` tsc 緑）。
- **回帰**: `pnpm exec vitest run` → **exit 0** / `Test Files 3 passed (3)` / `Tests 17 passed (17)`
  （旧 `tests/provider.spec.ts` 緑維持）。
- **lockfile 整合**: `pnpm install --frozen-lockfile` → **exit 0** / `all 3 workspace projects` / `Already up to date`。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- gate typecheck は source-only package を echo marker で通すため、移設 module 本体は gate 非被覆。
  最終的な型被覆は consumers 配線（`@vaz/agents` 5.2 / route.ts 6.3）で発生し、集約検証は 7.5。
  それまでは isolated tsc が唯一の型検証手段（2.2 以降の確立パターン）。
- **次**: 3.3（model-allowlist：R1.8 唯一の合法直書き箇所を新設。2.2 [FLAG] の env.ts 既定モデル ID との
  整合方針をここで確定）→ 3.4（telemetry、3.1 [FLAG] の supply-chain 依存判断を含む）。

---

## Task 3.3 — `packages/config/src/model-allowlist.ts`（R1.8 合法直書きの唯一の集約点）

- **日時**: 2026-07-04
- **Requirements**: 1.8
- **Boundary**: `packages/config/src/model-allowlist.ts`（単一ファイル、境界厳守）

### 実施内容 / [解決] R1.8 FLAG

- R1.8/ADR-5 の「合法なモデル ID 既定値の唯一の集約点」を新設。`research.md` ADR-5
  （grep gate は `claude-`/`llama3` literal を `@vaz/config`/env の**外**で検出、
  "One allow-list location for legitimate default IDs"）を根拠に、2.2 以降持ち越した R1.8 FLAG
  （env.ts の既定モデル ID 重複）を**設計上解決**:
  - env.ts（`@vaz/schemas` = 依存グラフ leaf、`@vaz/config` を import 不可）の `.default()` literal は
    grep gate の **env carve-out** で許容。
  - model-allowlist.ts が canonical allow-list。両者を同値（`claude-opus-4-8` / `llama3.2`）に保ち、
    7.4 が `@vaz/config` と env 双方を除外する。
- **設計**: `MODEL_ALLOWLIST`（provider → 非空 tuple）+ `DEFAULT_MODEL_ID`（各 allowlist 先頭要素
  ＝ default は必ずメンバー）。provider union は `@vaz/schemas/env` の `AiEnv["AI_PROVIDER"]` を
  type import し `satisfies Record<AiProvider, …>` で**全 provider 網羅を強制**（enum 追加時 未更新なら
  型エラー）。literal は本ファイルに一度だけ出現。

### TDD 判断（no-test-boundary / pure typed data）

- `@vaz/config` に test 境界無し（File Structure Plan 非掲載）。pure typed data のため 2.4/3.2 と同じ
  ephemeral type-probe で検証。現行タスクグラフに import consumer 無し（3.2 provider は 3.3 非依存、
  7.4 は grep で非 import）→ predicate 等 runtime ロジックは付けず「宣言＝合法在処の確立」を deliverable とした。

### 検証エビデンス（Verification Gate）

- **RED**: probe（`import { … } from "./model-allowlist"`）→ isolated tsc
  `packages/config/src/__probe.ts(3,51): error TS2307: Cannot find module './model-allowlist'`（exit 2）。
- **GREEN**: 作成後、probe / standalone とも isolated tsc → **exit 0**（`@vaz/schemas/env` type import 解決）。probe 削除。
- **負例（invariant 実証）**: `ollama` を一時削除 → `TS1360: … does not satisfy Record<"anthropic"|"ollama", …>`
  + `TS2339`（exit 2）→ 復元。網羅 invariant が実効的であることを証明。
- **同値**: allowlist の `claude-opus-4-8`/`llama3.2` が env.ts `.default()` と一致（grep 確認）。
- **biome**: `Checked 1 file … No fixes applied.`（exit 0）。
- **typecheck**: `mise run typecheck` → **exit 0**（`packages/config typecheck: Done` + root `./src` tsc 緑）。
- **回帰**: `pnpm exec vitest run` → **exit 0** / `Test Files 3 passed (3)` / `Tests 17 passed (17)`。
- **lockfile 整合**: `pnpm install --frozen-lockfile` → **exit 0** / `Already up to date`。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- R1.8 FLAG は「単一 SoT への統合」ではなく「grep exemption を 2 箇所（`@vaz/config` + env）に持つ」で
  ADR-5 準拠に決着。7.4 の `forbid-model-ids.sh` は **env（`@vaz/schemas/src/env.ts`）を除外パスに含める**こと
  が必須（含めないと env.ts の `.default()` literal で誤検出＝gate 赤化）。7.4 実装時の要件として申し送る。
- **次**: 3.4（telemetry：3.1 [FLAG] の `@ai-sdk/otel`/Langfuse OTLP supply-chain 依存判断を含む。
  Phase 1 Task 3 の最終サブタスク）。

---

## Task 3.4 — `packages/config/src/telemetry.ts`（`initTelemetry()` fail-soft OTel）

- **日時**: 2026-07-04
- **Requirements**: 4.1, 4.3, NFR-4, NFR-7
- **Boundary**: `packages/config/src/telemetry.ts`（+ 3.1 [FLAG] 事前承認による `packages/config/package.json` 境界拡張）

### 実施内容 / [解決] telemetry supply-chain FLAG（3.1）

- `initTelemetry(env?)`: `registerTelemetry(new OpenTelemetry())`（`registerTelemetry`=`ai@7.0.14` 既存 export、
  `OpenTelemetry`=`@ai-sdk/otel`）で AI SDK↔OTel bridge を無条件登録（NFR-7）。Langfuse OTLP は
  `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` 有時のみ（R4.3）、未設定時は `console.warn` を 1 回出し起動継続
  （NFR-4 fail-soft、never throw）。module-level `initialized` で register/warn を各 1 回に冪等化。
- **依存追加（境界拡張、3.1 で事前承認済み）**: `@ai-sdk/otel: "^1.0.14"` を `packages/config/package.json`（owner）へ。
  supply-chain 監査: `1.0.15`=7.6h → `minimumReleaseAge:1440` で除外、pnpm が **1.0.14**(41h)へ自動解決。
  install script 無し（allowBuilds 追記不要）。dep の `ai:7.0.14` が workspace 版と一致し **単一 ai copy に dedup**。

### 設計判断

- Langfuse env は `@vaz/schemas` schema 追加せず telemetry.ts で防御的直読み（env.ts は別境界・frozen、
  3.4 Requirements に NFR-3 非含、観測性は optional）。
- `console.warn` を採用（bootstrap 段で logger/deps 構築前に走るため、deps.ts の logger 契約は非使用）。
- OTLP exporter 実体は host（`registerOTel`, 6.4）へ委譲、telemetry.ts は bridge 登録 + fail-soft guard に限定。

### TDD 判断 / 検証エビデンス（Verification Gate）

- 実行時ロジック（warn-once / env 分岐 / no-throw）があるため ephemeral vitest spec
  （`tests/__telemetry.probe.spec.ts`、root include に載る位置、実行後削除）で RED→GREEN。mock 無しで real 契約を検証。
- **RED**: `Failed to resolve import "../packages/config/src/telemetry". Does the file exist?`（vitest exit 1）。
- **GREEN**: 作成後 `Test Files 1 passed (1)` / `Tests 2 passed (2)`（warn-once/no-throw/冪等 + Langfuse 分岐）。spec 削除。
- **isolated tsc**: telemetry.ts 単体 → **exit 0**（`@ai-sdk/otel` + `ai` 解決）。
- **biome**: `Checked 1 file … No fixes applied.`（`console.warn` は noConsole 非 error）。
- **typecheck**: `mise run typecheck` → **exit 0**（`packages/config typecheck: Done` + root `./src` tsc 緑）。
- **回帰**: `pnpm exec vitest run` → **exit 0** / `Test Files 3 passed (3)` / `Tests 17 passed (17)`（ephemeral 削除後）。
- **lockfile 整合**: `pnpm install --frozen-lockfile` → **exit 0** / `Already up to date`。
- **audit**: `pnpm audit --audit-level=moderate` → **exit 0** / `No known vulnerabilities found`（新規 OTel deps clean）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **Task 3 完了**: `@vaz/config`（provider / model-allowlist / telemetry）確立。3.1 の telemetry supply-chain FLAG は
  「owner=config/package.json へ境界拡張 + minimumReleaseAge 自動除外で 1.0.14 固定」で決着。
- **6.4 への申し送り**: `apps/web/instrumentation.ts` は `registerOTel`（`@vercel/otel`、要 apps/web 依存追加）で OTel
  provider + OTLP exporter（Langfuse: `OTEL_EXPORTER_OTLP_ENDPOINT`/headers or Langfuse SDK）を構成し、続けて
  `initTelemetry()` を呼ぶ。span 属性 `jobId`/`userId`/agent 付与は 16.1（Phase 4）。
- **次**: Task 4（`@vaz/tools`、Wave A の 3∥4 の残り）。

---

## Task 4.1 — `packages/tools/package.json`（`@vaz/tools` パッケージ定義）

_実施日: 2026-07-05 / Requirements: 1.4 / Depends: 2.1 / Wave A（3∥4 の残り）_

### 実施内容

- `@vaz/tools` を 2.1/3.1 と同型の source-only（JIT）パッケージとして定義：
  `type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }` wildcard /
  `typecheck` echo marker。wildcard export により後続 `time`/`index`（4.2–4.3）+ Phase 3+ の
  `email`（12.3）/`allowlist`（19.3）追加時も本 package.json の再編集は不要。

### 設計判断

- **単一編集境界としての dependencies 前方宣言**: 4.2/4.3 の編集境界は `src/*.ts` のみで package.json を
  再編集できない。よって 2.1/3.1 と同じく、R1.4（capability 移設）で必要な依存を 4.1 で先行宣言した。
  現行 `src/app/api/chat/route.ts` の `getCurrentTime`（4.2 で `createTimeCapability(deps)` へ移設）が
  消費するのは `ai`（`tool()`）+ `zod`（`inputSchema`）+ `@vaz/schemas`（`workspace:*`、4.2 が `deps.now`
  =`Clock` を `AgentDeps` から参照）。いずれも root/lockfile 既存の解決済みバージョン
  （`ai@^7.0.14` / `zod@^4.4.3` / workspace member）→ **新規外部依存ゼロ**（`pnpm install` は
  `downloaded 0, added 0`、supply-chain 判断不要・install script 無しで allowBuilds 追記不要）。
- **frozen mise typecheck 不変条件の継承（2.1 由来）**: `mise run typecheck` は `pnpm -r run typecheck`
  を用いるため、メンバー ≥1・該当 script 0 だと `ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT`。`@vaz/tools` も
  `typecheck` echo marker を必須で保持した（後続 5.1 以降の source-only package.json も同様に必須）。

### TDD 判断 / 検証エビデンス（Verification Gate）

- package.json 単体（実行時ロジック無し・tools に test 境界無し = File Structure Plan 非掲載）のため、
  2.1/3.1 と同じ migration-verification（install churn / recursive typecheck / 回帰）で検証。
- **RED**: `packages/tools` 不在（`ls` で確認）＝ workspace に `@vaz/tools` member 無し。
- **install（member 記録）**: `pnpm install` → `downloaded 0, added 0` / `Already up to date`
  （新規 external 解決ゼロ、lockfile へ member 追記のみ）。
- **GREEN — frozen lockfile**: `pnpm install --frozen-lockfile` → **exit 0** / `Already up to date`（churn ゼロ）。
- **GREEN — typecheck**: `mise run typecheck` → **exit 0**。`pnpm -r` が **3 projects**（schemas/config/tools）を
  scope し `packages/tools typecheck: Done`（recursive 不変条件維持）+ root `./src` tsc 緑。
- **GREEN — 回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（回帰なし）。
- **biome**: `biome check packages/tools/` → `Checked 1 file … No fixes applied.`（tabs/フォーマット準拠）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **4.1 完了**: `@vaz/tools` パッケージ骨格を確立。Wave A の `3 (P) ∥ 4 (P)` は 3 完了済み・4 着手。
- **次（4.2）**: `src/time.ts` に `createTimeCapability(deps)` を実装。`getCurrentTime` を deps closure 化し
  `new Date()` → `deps.now()`（`AgentDeps.now` = `Clock = () => Date`, 2.4）へ差し替え、unit-testable にする。
  ツール定義自体には test 境界が無いが、`deps.now` 注入で決定論的に検証可能な形へ寄せる（5.4 の MockModel
  テストで tool 選択とあわせて被覆される想定）。

---

## Task 4.2 — `packages/tools/src/time.ts`（`createTimeCapability(deps)`）

_実施日: 2026-07-05 / Requirements: 1.4 / Depends: 4.1, 2.4 / Wave A_

### 実施内容

- `createTimeCapability(deps)` を実装。route.ts の inline `getCurrentTime` を **挙動等価**で移設し、
  唯一の差分は clock source（`new Date()` → `deps.now()`）。`AgentDeps`（2.4）を closure から受け、
  `Clock = () => Date` の注入で ambient global を排して unit-testable 化（R1.4）。戻り値は
  `{ getCurrentTime }`（plan の capability 形状）。description / inputSchema（`timeZone` optional、
  IANA、既定 UTC）/ `Intl.DateTimeFormat("ja-JP", …)` は原型と同一。

### 設計判断

- 旧 route の inline tool は削除せず temporary duplication で保持（消費側再配線＝6.3 で route を
  薄い HTTP⇔Agent アダプタへ縮退する時点まで両緑）。
- `deps` は full `AgentDeps` を受けるが time capability が読むのは `now` のみ（capability factory は
  deps バンドル全体を受ける ADR-3 規約に一致）。`AgentDeps<DB=unknown>` の既定 generic を使用。

### TDD 判断 / 検証エビデンス（Verification Gate）

- tools に test 境界無し（File Structure Plan 非掲載）。実行時ロジックを持つため 3.4 と同じ
  **ephemeral vitest probe**（`tests/__time.probe.spec.ts`、root `include` 位置、実行後削除）で RED→GREEN。
- **RED**: `time.ts` 不在 → probe の `import "../packages/tools/src/time"` が解決失敗
  （vitest `Test Files 1 failed (1)` / `Tests no tests`）。
- **GREEN**: time.ts 作成後 `Test Files 1 passed (1)` / `Tests 3 passed (3)`。検証観点（mock なしの real 契約）:
  (1) 注入 clock の決定論性（pin した `2000-01-01T12:34:56Z` を `Intl` 期待値と完全一致・年 "2000" 含有で
  ambient `new Date()` 不使用を実証）、(2) `timeZone` 省略時 UTC 既定、(3) clock 違いの 2 capability が
  異なる出力＝closure 独立（global 非依存）。→ probe 削除。
- **isolated tsc**: `tsc --ignoreConfig --strict --skipLibCheck --module esnext --moduleResolution bundler`
  → **exit 0**（`@vaz/schemas/deps` + `ai` + `zod` を `packages/tools/node_modules/@vaz/schemas` symlink 経由で解決）。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（probe 削除後）。
- **typecheck**: `mise run typecheck` → **exit 0**（`packages/tools typecheck: Done` + schemas/config + root tsc）。
- **lint**: 初回 biome で 100-char 超の `timeZone: z.string()…` 行を折返し要求（format-only、logic 影響なし）
  → `biome check --write` 適用後 `mise run lint` → **exit 0**（`Checked 32 files … No fixes applied.`）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **4.2 完了**: time capability を deps closure 化で確立。残り Task 4 は 4.3（`src/index.ts` で集約 export）。
- **次（4.3）**: `packages/tools/src/index.ts` から `createTimeCapability` を re-export（capability の集約点）。
  Phase 3+ の `email`/`allowlist` capability もここへ追加される想定。5.2 の `createChatAgent` は
  `@vaz/tools`（index）から capability を取得して tools 登録する。

---

## Task 4.3 — `packages/tools/src/index.ts`（capability 集約 barrel）

_実施日: 2026-07-05 / Requirements: 1.4 / Depends: 4.2 / Wave A_

### 実施内容

- capability 集約 barrel を新設し `createTimeCapability` を re-export
  （`export { createTimeCapability } from "./time";` = value re-export、`verbatimModuleSyntax` 準拠）。
  consumers（5.2 `createChatAgent`）は `@vaz/tools/index`（`"./*": "./src/*.ts"` exports map）から
  capability を取得する単一入口。Phase 3+ の `email`（12.3）/`allowlist`（19.3）もここへ追加される想定。

### 設計判断

- barrel は runtime ロジックを持たない純粋な re-export。`export *` ではなく明示 named re-export を採用
  （現状 export は `createTimeCapability` 1 件、意図を明示し将来の暗黙 export 混入を防ぐ）。
- bare `@vaz/tools`（`"."` エントリ）は exports map に無く未解決 → 意図通り subpath（`/index`, `/time`）
  参照に統一（2.1/3.1 と同じ source-only wildcard 方針）。

### TDD 判断 / 検証エビデンス（Verification Gate）

- tools に test 境界無し → ephemeral vitest probe（`tests/__tools-index.probe.spec.ts`、実行後削除）で RED→GREEN。
- **RED**: index.ts 不在 → probe の `import "../packages/tools/src/index"` が解決失敗
  （`Test Files 1 failed (1)` / `Tests no tests`）。
- **GREEN**: index.ts 作成後 `Test Files 1 passed (1)` / `Tests 1 passed (1)`（re-export が解決し
  `createTimeCapability` が function、`getCurrentTime` を生成＝aggregation 配線の実証）→ probe 削除。
- **isolated tsc**: `tsc --ignoreConfig --strict --moduleResolution bundler` → **exit 0**
  （`./time` 経由で `@vaz/schemas/deps` + `ai` + `zod` を transitive 解決）。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（probe 削除後）。
- **typecheck**: `mise run typecheck` → **exit 0**（`packages/tools typecheck: Done`）。
- **lint**: `mise run lint` → **exit 0**（`Checked 33 files … No fixes applied.`、index.ts 追加で 32→33）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **Task 4 完了**: 4.1–4.3 全緑。`@vaz/tools`（package.json / time / index）確立。deps closure 化した
  `createTimeCapability` + 集約 barrel で capability パッケージの Phase 1 分が揃った。
- **Wave A 進捗**: `1 → 2 → {3 (P) ∥ 4 (P)}` の 3・4 が両完了。**次は Task 5（`@vaz/agents`）**。
- **5.x への申し送り**:
  - 5.1: `@vaz/agents/package.json`（`@vaz/schemas`/`@vaz/config`/`@vaz/tools` を `workspace:*` 依存、
    source-only なら `typecheck` echo marker 必須＝2.1 由来の不変条件）。
  - 5.2: `createChatAgent(deps)` は現行 route の `streamText({ model: resolveModel(), tools, stopWhen })` を
    **挙動等価**で封じ込め。model は `@vaz/config/provider#resolveModel`、tools は `@vaz/tools/index#createTimeCapability(deps)`
    の `{ getCurrentTime }`、`stopWhen: isStepCount(5)`。回帰緑後に `ToolLoopAgent` 化。
  - 5.4: `MockLanguageModelV4`（`ai/test`）+ mock deps で **これが tools/agents の durable な単体テスト境界**
    （4.x の ephemeral probe が担っていた検証を恒久化）。ネットワークなしで tool 選択/ループ制御を検証。

---

## Task 5.1 — `@vaz/agents` パッケージ定義（2026-07-05）

### Do（実施）

- `packages/agents/package.json` を新設し `@vaz/agents` を 2.1/3.1/4.1 と同型の source-only(JIT)
  パッケージとして定義（`type: module` / `sideEffects: false` / `exports: { "./*": "./src/*.ts" }`
  wildcard / `typecheck` echo marker）。
- **依存の前方宣言**（package.json は単一編集境界＝5.2/5.3/5.4 から再編集不可）:
  `@vaz/schemas`(workspace:*, AgentDeps=2.4) / `@vaz/config`(workspace:*, resolveModel=3.2) /
  `@vaz/tools`(workspace:*, createTimeCapability=4.3) / `ai`(^7.0.14, streamText/isStepCount=5.2 +
  ai/test MockLanguageModelV4=5.4)。`zod` は非宣言（tools が inputSchema 所有、@vaz/config と同方針）。
- 全依存が root/lockfile 既存 → **新規外部依存ゼロ**（supply-chain 判断不要・allowBuilds 追記不要）。

### TDD 判断 / 検証エビデンス（Verification Gate）

- package.json は scaffold（tasks.md 規約 L14-17: unit ロジックではない）→ 失敗テスト不要、
  検証は install + gate。
- **install**: `pnpm install` → `Scope: all 5 workspace projects` / `downloaded 0, added 0`
  （member 記録、外部 dep ゼロ）→ `--frozen-lockfile` → `Already up to date`（churn ゼロ）。
- **typecheck**: `mise run typecheck` → **exit 0**（`pnpm -r` scope 4 of 5、`packages/agents typecheck: Done`
  ＝2.1 由来の「member ≥1 は typecheck script 必須」不変条件を維持、root tsc も緑）。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（回帰なし）。
- **lint**: `mise run lint` → **exit 0**（`Checked 34 files … No fixes applied.`、package.json 追加で 33→34）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **Task 5.1 完了**: `@vaz/agents` の骨格確立。Wave A `1 → 2 → {3∥4} → 5` の Task 5 に着手。
- **agents は test 境界を持つ最初の package**（5.4 `tests/chat-agent.spec.ts`）。5.x での申し送り:
  - 5.2: `createChatAgent(deps)` は現行 route の `streamText({ model: resolveModel(), tools, stopWhen })`
    を挙動等価で封じ込め。model=`@vaz/config/provider#resolveModel`、tools=`@vaz/tools/index#createTimeCapability(deps)`
    の `{ getCurrentTime }`、`stopWhen: isStepCount(5)`。回帰緑後に `ToolLoopAgent` 化。
  - 5.4: `MockLanguageModelV4`（`ai/test`）+ mock deps が **durable な単体テスト境界**。Red-Green で
    5.2 実装前に失敗テスト先行（5.4 は 5.1 のみに依存、5.2 実装完了は前提としない）。ネットワークなしで
    tool 選択/ループ制御を検証。
  - typecheck 被覆: agents src は未 import のため gate は echo marker で非被覆。最終被覆は consumer 配線
    （6.3 route）+ 7.5、tests は Vitest projects（7.1）。

---

## Task 5.2 — `createChatAgent(deps)` エージェントコア（2026-07-05）

### Do（実施）

- `packages/agents/src/chat-agent.ts` に `createChatAgent(deps, options?)` を実装。現行 route の
  `streamText({ model: resolveModel(), messages: await convertToModelMessages(...), tools: { getCurrentTime },
  stopWhen: isStepCount(5) })` を **挙動等価**で封じ込め（R1.3/1.7）。
- 差分: model=`@vaz/config/provider#resolveModel`、tools=`@vaz/tools/index#createTimeCapability(deps)` の
  `{ getCurrentTime }`（inline 廃止→capability closure）。UI stream ブリッジは route 側に残す（plan L113-115、6.3）。
- `stream({ messages })` は `convertToModelMessages`（`Promise<ModelMessage[]>`）await で async、
  戻り値 `StreamTextResult`（route は `result.stream` を消費）。

### 試行錯誤 / 設計判断

- **model injection seam**: plan 公開 IF は `createChatAgent(deps)` のみだが、R1.6（`MockLanguageModelV4` で
  network なし検証）が model 注入点を要求。optional 第2引数 `options.model`（既定 `?? resolveModel()`）で
  call site を不変に保ちつつ seam を提供。既定経路は stream() 毎に遅延 `resolveModel()` → per-request env
  解決（R1.8/NFR-3）を保持。docs `03-ai-sdk-core/55-testing.mdx` で streamText+MockLanguageModelV4 の
  `model:` 注入パターンを確認。
- **`convertToModelMessages` は async**（`node_modules/ai/dist/index.d.ts:5655` = `Promise<ModelMessage[]>`）→
  現行 route の `await` を stream() 内へ移送、stream() を async 化。
- **`generate` 未実装**: 現行 route は stream のみ。「挙動等価封じ込め」に忠実に stream のみ（generate は
  保存すべき現行挙動なし）→ ToolLoopAgent 化 or Phase 3 で追加。

### TDD 判断 / 検証エビデンス（Verification Gate）

- 5.2 境界は `chat-agent.ts` のみ、durable test は 5.4（別境界）→ ephemeral vitest probe
  （`tests/__chat-agent.probe.spec.ts`、実行後削除）で RED→GREEN。
- **RED**: `chat-agent` 不在で `import "../packages/agents/src/chat-agent"` 解決失敗
  → `Test Files 1 failed (1)` / `Tests no tests`。
- **GREEN**: 実装後 `Test Files 1 passed (1)` / `Tests 1 passed (1)`
  （`createChatAgent(deps,{model:MockLanguageModelV4})` が `stream` を持ち、`stream({messages})` が
  `convertToModelMessages` 経由で `.stream`/`.textStream` を持つ `StreamTextResult` を network なしで返す）→ probe 削除。
- **isolated tsc**: `--ignoreConfig --strict --moduleResolution bundler` → **exit 0**
  （`@vaz/config/provider` + `@vaz/schemas/deps` + `@vaz/tools/index` + `ai` 解決）。
- **typecheck**: `mise run typecheck` → **exit 0**。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（probe 削除後）。
- **lint**: `mise run lint` → **exit 0**（`Checked 35 files … No fixes applied.`、chat-agent.ts 追加で 34→35）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **Task 5.2 完了**: `createChatAgent` エージェントコア確立。次は **5.3**（`src/index.ts` 公開 API＝
  `createChatAgent`/`AgentDeps`/`ChatAgent` 再 export）→ **5.4**（durable 単体テスト）。
- **5.3 申し送り**: index.ts は `createChatAgent`（value）+ `ChatAgent`/`ChatAgentStreamOptions`/
  `CreateChatAgentOptions`（type）を re-export。`AgentDeps` は `@vaz/schemas/deps` 由来を re-export
  （consumer が単一 entry で取得できるよう、plan L109-110 の公開 IF）。
- **5.4 申し送り**: probe が担った検証を恒久化。`MockLanguageModelV4`（`ai/test`）を `options.model` へ
  注入し、tool 選択（getCurrentTime 呼び出し）・ループ制御（`isStepCount(5)`）を network なしで検証。
  mock deps（`now` 固定 Clock 等）で `getCurrentTime` の決定論も検証可。probe と異なり stream を
  **消費**して tool-call/finish を assert する（docs 55-testing.mdx の chunk 形状を流用）。
- **6.3 申し送り**: route は `createChatAgent(deps).stream({messages})` → `toUIMessageStream({stream: result.stream})`
  → `createUIMessageStreamResponse`。deps（logger/now/db）は route で構築。model 注入は省略（既定 resolveModel）。

---

## Task 5.3 — `@vaz/agents` 公開 API barrel（2026-07-05）

### Do（実施）

- `packages/agents/src/index.ts`（公開 API barrel）を新設。
  - value: `export { createChatAgent } from "./chat-agent"`（verbatimModuleSyntax 準拠）
  - type: `export type { ChatAgent, ChatAgentStreamOptions, CreateChatAgentOptions } from "./chat-agent"`
  - type: `export type { AgentDeps } from "@vaz/schemas/deps"`（単一正本を単一 entry で再 export、plan L109-110）
- consumers（6.3 route / 5.4 tests）は `@vaz/agents/index`（`"./*": "./src/*.ts"` map）から取得。

### 試行錯誤 / エラー（root cause）

- **biome lint 赤化 → 特定 → 解決**: 初版は AgentDeps 用 doc コメントを export 間に挟んだため
  `assist/source/organizeImports`（FIXABLE, `Sort these exports`）で失敗（`[lint] ERROR task failed`）。
  - **root cause**: biome の export 並べ替えは決定論的 — canonical order は「外部 `@vaz/schemas/deps` →
    相対 `./chat-agent`、同一 module 内は `export type` → value」。interleaved コメントが並べ替え対象を跨ぎ衝突。
  - **対処**（blind retry 回避）: interleaved コメントを廃し単一 top doc block へ集約、canonical 順で再記述。

### TDD 判断 / 検証エビデンス（Verification Gate）

- 5.3 境界は `index.ts` のみ、durable test は 5.4 → ephemeral probe（`tests/__agents-index.probe.spec.ts`、削除）で RED→GREEN。
- **RED**: `../packages/agents/src/index` 解決失敗 → `Test Files 1 failed (1)` / `Tests no tests`。
- **GREEN**: 実装後 `Test Files 1 passed (1)` / `Tests 1 passed (1)`（barrel が `createChatAgent` を re-export、
  `createChatAgent(deps)` construction が `stream` を持つ agent を network なしで生成）→ probe 削除。
- **isolated tsc**: `--ignoreConfig --strict --moduleResolution bundler` → **exit 0**
  （value+type re-export が `./chat-agent` 連鎖 + `@vaz/schemas/deps` を解決）。
- **typecheck**: `mise run typecheck` → **exit 0**。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（probe 削除後）。
- **lint**: `mise run lint` → **exit 0**（`Checked 36 files … No fixes applied.`、index.ts 追加で 35→36、順序修正後）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **Task 5.3 完了**: `@vaz/agents` 公開 API 確立（createChatAgent + AgentDeps + agent 型群を単一 entry で提供）。
- **Task 5 残 1**: **5.4**（durable 単体テスト、`packages/agents/tests/chat-agent.spec.ts`）。5.2/5.3 の
  ephemeral probe が担った検証を恒久化。`MockLanguageModelV4`（`ai/test`）を `options.model` へ注入し、
  **stream を消費**して tool 選択（getCurrentTime）・ループ制御（`isStepCount(5)`）・スキーマ適合を network なしで検証。
  mock deps（固定 Clock 等）で getCurrentTime の決定論も検証可（docs `03-ai-sdk-core/55-testing.mdx` の chunk 形状流用）。
  - **注意（5.4 の test 配線）**: agents は `packages/agents/tests/**` に test 境界を持つ最初の package。現行 root
    vitest include は `tests/**` のみ（`vitest.config.ts:15`）→ 5.4 の spec は Vitest projects 化（7.1）まで
    root include に含まれない。5.4 実行時に **一時的な include 追加 or `pnpm exec vitest run <path>` 直接指定**で
    緑を確認し、恒久配線は 7.1 に委譲する（package.json の typecheck echo marker 不変条件も維持）。
- **lint 教訓**: barrel の re-export は「外部→相対、type→value」の biome canonical order で最初から記述する
  （interleaved コメントを避ける）。後続 barrel（5.x 以降 / index 追加時）に適用。

---

## Task 5.4 — `MockLanguageModelV4` durable 単体テスト（2026-07-05）

### Do（実施）

- `packages/agents/tests/chat-agent.spec.ts`（durable 単体テスト、R1.6）を新設。`MockLanguageModelV4`
  （`ai/test`）を `options.model` seam（5.2）へ注入し **network / 実 LLM 呼び出しなし**で検証。
- 2 ケース: (a) 単一ターン text（tool 非選択、`doStreamCalls` 1）、(b) `getCurrentTime` 選択→ループ継続→
  最終応答（tool selection + loop control、`doStreamCalls` 2）。mock deps=no-op logger / 固定 Clock / db=null。

### 設計 / 実地確認（ai@7.0.14）

- `MockLanguageModelV4({ doStream: [r1, r2] })` は per-call 消費（`ai/dist/test/index.js:152`
  = `doStream[doStreamCalls.length-1]`）→ turn ごとに別レスポンス。`doStreamCalls.length` がループ step 数。
- V4 stream chunk 形状（`@ai-sdk/provider@4.0.2` `LanguageModelV4StreamPart`）:
  - `tool-call` = `{type,toolCallId,toolName,input:<stringified JSON>}`
  - `finish` = `{type,finishReason:{unified,raw},usage:{inputTokens{total,noCache,cacheRead,cacheWrite},outputTokens{total,text,reasoning}}}`
  - `text-start`/`text-delta`/`text-end`
- `TypedToolCall.input`=parsed object、`TypedToolResult.output`=tool 戻り値（`ai/dist/index.d.ts`）。
- chunk リテラルの型 widening 回避のため mock を **inline 構築**（constructor の contextual type で narrowing）。
  extracted helper は `type: string` に widen し discriminated union に不一致 → inline 必須。

### 試行錯誤 / TDD（RED-Green + 非空虚性）

- 本モジュールの test-first RED は 5.2 の ephemeral probe（module 不在→import 失敗）で既達。
- durable spec の**非空虚性**を mutation で実証: loop-control 期待値 2→1 に一時改変 → RED
  （`AssertionError: expected [ {…},{…} ] to have a length of 1 but got 2`）→ 復帰 → GREEN。
- **配線問題（root vitest include）**: 本 spec は `packages/agents/tests/**`、root include は `tests/**` のみ
  → `mise run test:run` 未含。**ephemeral config**（`vitest.agents.tmp.config.ts`、node env/globals、実行後削除）で
  VERIFY。恒久配線（Vitest projects node）は 7.1 へ委譲。

### 検証エビデンス（Verification Gate）

- **agents spec（ephemeral config）**: `Test Files 1 passed (1)` / `Tests 2 passed (2)`。
- **mutation RED**: `Test Files 1 failed (1)` / `Tests 1 failed | 1 passed (2)`（loop-control assertion がバイト）→ 復帰後 GREEN。
- **isolated tsc**: `--ignoreConfig --strict --moduleResolution bundler --types node,vitest/globals` → **exit 0**（型健全）。
- **typecheck**: `mise run typecheck` → **exit 0**。
- **lint**: `mise run lint` → **exit 0**（`Checked 37 files … No fixes applied.`、spec 追加で 36→37）。
- **回帰 vitest（root）**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`
  （agents spec は root include 外＝設計通り、回帰なし）。
- build は既存 [FLAG]（`/_not-found` prerender）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **Task 5 完了**（5.1–5.4 全緑）: `@vaz/agents` エージェントコア確立。`createChatAgent(deps, options?)` は
  現行 route の `streamText`+tools+`isStepCount(5)` を挙動等価封じ込め（R1.3/1.7）、model 注入 seam で
  resolveModel 既定（per-request env 解決）と mock 注入を両立、`MockLanguageModelV4` で network-free に
  tool 選択/ループ制御を検証（R1.6）。
- **次は Task 6（`apps/web` 移設）**:
  - 6.1: `apps/web/package.json`（`@vaz/*` 依存）+ `tsconfig.json`（base 継承 + `@ → src`）。
  - 6.2: `next.config.ts`/`layout`/`page`/`features/chat`/`global.scss` を `apps/web` へ移設（React Compiler は web のみ）。
  - 6.3: route を薄アダプタ化 → `createChatAgent(deps).stream({messages})` → `toUIMessageStream({stream: result.stream})`
    → `createUIMessageStreamResponse`。deps（logger/now/db）は route 構築、model 注入は省略（既定 resolveModel）。
  - 6.4: `instrumentation.ts` で `registerOTel` + `initTelemetry()`。
  - **重要な後片付け（Task 6 で解消）**: 旧 `src/lib/ai/{env,chat-schema,provider}.ts` と route inline `getCurrentTime`
    は app 移設まで temporary duplication。6.3/6 で新 packages へ再配線し重複解消。
  - **7.1 申し送り**: Vitest projects（web=jsdom / node packages=agents,rag）で `packages/agents/tests/**` を
    恒久 include。5.4 の ephemeral config はその雛形（node env/globals/include）。

---

## Task 6.1 — `apps/web/package.json` + `apps/web/tsconfig.json`（`@vaz/web` member 実体化）

_実施日: 2026-07-05 / Requirements: 1.5 / Depends: 5.3 / Wave A（Task 6 の起点）_

### 実施内容

- `apps/web`（`@vaz/web`）を 6 番目の workspace member として実体化。`package.json`（deps 宣言・
  guarded `typecheck` script）+ `tsconfig.json`（共有 base 継承 + Next/React overlay + `@ → src` alias）を作成。
- app 本体（`src/**`・`next.config.ts` 等）の移設は 6.2。旧 root `./src` は temporary duplication で保持。

### 設計判断

- **単一編集境界としての dependencies 前方宣言（2.1/3.1/4.1/5.1 継承）**: `apps/web/package.json` は Phase 1 で
  6.1 が唯一の編集境界。6.2（`next.config`/`layout`/`page`/`features`/`scss`）・6.3（`route.ts`）・6.4
  （`instrumentation.ts`）はいずれも別ファイル境界で package.json を再編集できない。よって 6.2–6.4 で apps/web が
  消費する全 direct dep を 6.1 で先行宣言:
  - 移設ファイル/route/instrumentation が import する外部: `@ai-sdk/react` / `@carbon/react` / `@carbon/styles` /
    `ai` / `next` / `react` / `react-dom`（既存 root/lockfile 解決済み、新規外部ゼロ）。
  - workspace: `@vaz/agents`（route: `createChatAgent`）/ `@vaz/schemas`（route: `chatRequestSchema`）/
    `@vaz/config`（instrumentation: `initTelemetry`）。
  - 新規外部: `@vercel/otel`（6.4: `registerOTel`。do.md「6.4 への申し送り＝要 apps/web 依存追加」に対応）。
  - **非宣言（transitive、direct-deps-only）**: `@vaz/tools`（agents 経由）/ `zod`（薄 route は schemas 経由で検証、
    直接 import せず）/ `@ai-sdk/anthropic`・`@ai-sdk/openai-compatible`（config 経由）。5.1 の方針を踏襲。
- **[解決] @vercel/otel supply-chain 監査**: `latest`=`2.1.3`（2026-06-11 公開、>24h）→ `minimumReleaseAge:1440`
  に抵触せず解決。`pnpm install`=`+14`（`@vercel/otel` + 推移的 `@opentelemetry/*`）だが **"Ignored build scripts"
  警告なし** → install script 無し → `allowBuilds`（pnpm-workspace.yaml、6.1 境界外）追記不要。`pnpm audit`=clean。
- **devDependencies 非宣言（他 4 パッケージと同型）**: tooling（typescript/biome/vitest/sass/
  babel-plugin-react-compiler/@types/*）は root 集約。pnpm の ancestor `node_modules/.bin` PATH + Node 親
  node_modules 解決で apps/web から到達するため per-app 宣言は不要。
- **移行期の両状態緑（Task 1「前方互換」idiom）**: `typecheck` script を `if [ -d src ]; then tsc --noEmit; else echo … skip; fi`
  ガードに。6.1（src 未移設＝skip・緑）と 6.2 移設後（src 在中＝`tsc` 実 typecheck、`@vaz/*` の JIT source を transitive
  型検査）の双方で緑。凍結 mise（1.3）の `pnpm -r run typecheck`（member ≥1 で該当 script 必須の不変条件）も充足。
- **tsconfig 設計**: 現行 root `tsconfig.json`（動作実績あり）の compilerOptions を踏襲し、`extends` のみ
  `../../packages/config/tsconfig.base.json` へ repoint。`references: []`（未実体メンバー参照で TS6053 を避ける、root と同方針）。

### TDD 判断 / 検証エビデンス（Verification Gate）

- **no source-boundary scaffolding**: 2.1/3.1/4.1/5.1 と同様、本タスクは `.ts` source を持たず（File Structure Plan に
  test 境界非掲載）、ephemeral probe も不要（config ファイルのみ）。検証は workspace gate で実施。
- **typecheck**: `mise run typecheck` → **exit 0**（`apps/web typecheck: … skip` + schemas/config/tools/agents echo +
  root `./src` tsc 緑）。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（回帰なし）。
- **lint**: `mise run lint` → `Checked 39 files … No fixes applied.`（37→39、package.json + tsconfig.json 追加、
  biome tabs/format 準拠）。
- **audit**: `pnpm audit --audit-level=moderate` → `No known vulnerabilities found`（新規 OTel deps clean）。
- **lockfile 整合**: `pnpm install --frozen-lockfile` → `Already up to date`。
- build は既存 [FLAG]（`/_not-found` prerender、HEAD 由来・6.1 の回帰でない）につき非対象・7.5 トリアージ。

### 学び / Act 申し送り

- **6.2 申し送り**: `src/**`・`next.config.ts`・`next-env.d.ts` を `apps/web` へ移設。移設完了で旧 root `./src` 消滅 →
  mise typecheck の root tsc が `[ -d src ]` false で skip、apps/web の guarded typecheck が実 `tsc --noEmit` へ切替
  （この時点で `@vaz/*` JIT source が apps/web 経由で初めて gate 型検査に載る）。React Compiler は web のみ
  （`next.config.ts` `reactCompiler:true`）。
- **6.3 申し送り**: route を薄アダプタ化（`chatRequestSchema` 検証 → `createChatAgent(deps).stream({messages})` →
  `toUIMessageStream({stream: result.stream})` → `createUIMessageStreamResponse`）。deps（logger/now/db）は route 構築、
  model 注入は省略（既定 `resolveModel`、per-request env 解決を維持）。旧 `src/lib/ai/*` + route inline `getCurrentTime` を撤去。
- **6.4 申し送り**: `instrumentation.ts` で `registerOTel`（`@vercel/otel@2.1.3`、6.1 で宣言済み）+ `initTelemetry()`。
  peer warning は @vercel/otel 起因なし（既存ツリー由来）。
- **次**: Task 6.2（app 本体の `apps/web` 移設）。

---

## Task 6.2 — UI/設定ファイルの `apps/web` 移設（layout/page/features/global.scss/next.config）

_実施日: 2026-07-05 / Requirements: 1.7 / Depends: 6.1 / Wave A（Task 6 継続）_

### 実施内容

- `next.config.ts` / `src/app/{layout,page}.tsx` / `src/features/chat/{Chat.tsx,Chat.module.scss}` /
  `src/assets/styles/global.scss` を `apps/web` 配下へ **byte-identical** に配置（`cp` + `diff -q` で 6/6 一致）。
- `page.tsx` は Server Component 維持、React Compiler は web のみ（`apps/web/next.config.ts` `reactCompiler:true`）、挙動等価。

### 設計判断

- **move ではなく temporary duplication（2.2/2.3/3.2/4.2 継承）**: plan は "Modify(move)" だが、root 原本削除は
  6.2 境界外の資産を即回帰させる — `tests/Chat.spec.tsx`（`@/features/chat/Chat` を import、root vitest
  `include: tests/**` + alias `@→./src`）と root `tsc`（`./src` include）。`tests/**`・`vitest.config.ts` の
  web project 化=7.1、E2E 移設=7.2、route+`lib/ai` retire=6.3 は全て 6.2 境界外。よって「no regression（17 tests 緑）」
  ×「境界厳守」の唯一解として root 原本を保持し apps/web へ複製。root `./src` 完全撤去は 6.3/7.1 後に可能。
- **mise typecheck の二重被覆（両状態緑）**: root `./src` 残存のため、現状 `pnpm -r run typecheck`（apps/web guarded
  `tsc` が `[ -d src ]` true で実 tsc 実行、`@vaz/*` JIT source を transitive 検査）+ root `./src` tsc の双方が緑。
  Task 1.3 想定の「root tsc skip」は root `./src` 撤去後に発火。
- **apps/web の Next 型アーティファクト生成**: guarded `tsc` は `.scss` side-effect import
  （`noUncheckedSideEffectImports`）+ next 型のため `next-env.d.ts` + `.next/types/routes.d.ts` を要する。
  `pnpm --filter @vaz/web exec next build` で生成（build は既存 FLAG で exit 1 だが型生成は prerender 前に完了）。
  両者は gitignore 対象（`.next`/`next-env.d.ts`）で `git status` 非汚染。

### 検証エビデンス（Verification Gate）

- **typecheck**: `mise run typecheck` → **exit 0**（`apps/web typecheck: Done` 実 tsc + root `./src` tsc 緑 + 4 packages echo）。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（root 複製保持で Chat.spec 緑、回帰なし）。
- **lint**: `mise run lint` → `Checked 43 files … No fixes applied.`（39→43、`.ts/.tsx` 4 追加、scss は biome 非対象＝count 外）。
- **audit**: `pnpm audit --audit-level=moderate` → `No known vulnerabilities found`。
- **lockfile 整合**: `pnpm install --frozen-lockfile` → `Already up to date`（複製は dep 不変＝churn ゼロ）。
- **[FLAG] build**: `pnpm --filter @vaz/web exec next build` → exit 1（`/_global-error`・`/_not-found` prerender で
  `TypeError: Cannot read properties of null (reading 'useContext')`）。HEAD の `/_not-found` FLAG（1.2 記録）と同一クラス
  （React 19.2 × Next 16 error-page prerender、byte-identical 複製ゆえ回帰でない）。7.5 前に要トリアージ。

### 学び / Act 申し送り

- **6.3 申し送り**: `apps/web/src/app/api/chat/route.ts` を薄アダプタとして作成し、root `src/app/api/chat/route.ts` +
  `src/lib/ai/{env,chat-schema,provider}.ts` を撤去。撤去後は root `tests/{chat-schema,provider}.spec.ts` の被写体が消える
  ため、その再配線（apps/web vitest project へ移設 or 撤去）を 7.1 と整合させる。route の deps（logger/now/db）は route 側で
  構築、model 注入は省略（既定 `resolveModel`、per-request env 解決を維持）。
- **7.1 申し送り**: root UI 複製（layout/page/features/global.scss）と `tests/Chat.spec.tsx` は、Vitest projects
  （web=jsdom）で apps/web を対象化する 7.1 で web project 側へ収斂。収斂後に root `./src` UI を撤去でき、mise typecheck の
  root tsc skip が発火する。
- **次**: Task 6.3（route 薄アダプタ化）。

---

## Task 6.3 — `apps/web/src/app/api/chat/route.ts`（薄い HTTP⇔Agent アダプタ化）

_実施日: 2026-07-05 / Requirements: 1.5, 1.7 / Depends: 6.1, 5.3 / Wave A（Task 6 継続）_

### 実施内容

- `apps/web/src/app/api/chat/route.ts` を薄いアダプタとして新設: `chatRequestSchema`（`@vaz/schemas/chat`）で body 検証 →
  `AgentDeps` 構築 → `await createChatAgent(deps).stream({ messages })`（`@vaz/agents/index`）→
  `toUIMessageStream({ stream: result.stream })` → `createUIMessageStreamResponse`。オーケストレーションは route に置かず
  `@vaz/agents` 内（R1.5）。400 応答規約（不正 JSON / Zod 失敗）と UI stream 形状（`useChat` 互換, R1.7）を保持。

### 設計判断

- **統合 typecheck の初点火**: 本 route が `@vaz/*` チェーン全体（agents→config/tools/schemas）の最初の実 consumer。
  apps/web guarded `tsc` が route→`@vaz/*` 全鎖を transitive 型検査し exit 0 ―― 5.2「挙動等価封じ込め」が route 呼出し形状
  （`stream({messages})`→`result.stream`）と型整合することを実証。
- **deps 構築（route 責務、do.md 6.2 申し送り通り）**: `db: null`（Phase 1 stateless）/ `now: () => new Date()`
  （旧 inline tool と等価）/ `logger`: console-backed（message + 明示 fields のみ、raw prompt/tool I/O 非転送＝R4.7 準拠）/
  audit 省略＝no-op（2.4）。
- **境界厳守 → temporary duplication 継続**: 6.3 境界は apps/web route のみ。旧 root route + `lib/ai/{env,chat-schema,provider}`
  は `tests/{chat-schema,provider}.spec.ts`（境界外）が現用ゆえ非削除（両緑）。root 撤去は 7.1（unit test の web project 収斂）で。

### 検証エビデンス（Verification Gate）

- **typecheck**: `mise run typecheck` → **exit 0**（`apps/web typecheck: Done` 実 tsc で route→`@vaz/*` 全鎖検査 + root `./src` tsc 緑）。
- **回帰 vitest**: `mise run test:run` → `Test Files 3 passed (3)` / `Tests 17 passed (17)`（回帰なし）。
- **lint**: 初版の三項 logger 行が 100-char 超 → `mise run lint:fix`（biome 決定論的折返し、logic 不変）→ 再 check
  `Checked 44 files … No fixes applied.`。
- **audit**: `No known vulnerabilities found`。**lockfile**: `--frozen-lockfile` Already up to date。
- **build**: `next build`（apps/web）は route を `.next/types/validator.ts` へ型検証付きコンパイル、失敗は既存 `/_global-error`
  prerender FLAG のみ（route 起因エラーなし＝非回帰）。7.5 トリアージ。

### 学び / Act 申し送り

- **6.4 申し送り**: `apps/web/instrumentation.ts` で `registerOTel`（`@vercel/otel`、6.1 で宣言済み）+ `initTelemetry()`
  （`@vaz/config/telemetry`）。Next は instrumentation.ts の `register()` を起動時 1 回呼ぶ。
- **7.1 申し送り**: 旧 root route + `lib/ai` + UI 複製 + `tests/{Chat,chat-schema,provider}.spec.ts` は Vitest projects 化
  （web=jsdom, node packages）で apps/web/tests へ収斂させ、収斂後に root `./src` を撤去（mise の root tsc skip が発火）。
- **次**: Task 6.4（instrumentation.ts / OTel 起動）。

---

## Task 6.4 — `apps/web/instrumentation.ts`（registerOTel + initTelemetry / OTel 起動）

_実施日: 2026-07-05 / Requirements: 4.1, NFR-7 / Depends: 6.1, 3.4 / Wave A（Task 6 完了点）_

### 実施内容

- `apps/web/instrumentation.ts`（Next instrumentation hook、起動時 1 回）を新設。`register()`:
  `registerOTel({ serviceName: "vaz-web" })`（`@vercel/otel`、OTel SDK + OTLP trace exporter を host 構成）→
  `initTelemetry()`（`@vaz/config/telemetry`、AI SDK↔OTel bridge 登録）。全 `streamText`/agent 呼出しに span（R4.1/NFR-7）。

### 設計判断

- **順序**: provider 確立（registerOTel）→ bridge 接続（initTelemetry）が必須（bridge は既存の global tracer provider に
  attach するため）。do.md 3.4 の「registerOTel を構成し続けて initTelemetry()」に一致。
- **fail-soft（NFR-4）**: initTelemetry は telemetry env 不在時 warn 1 回で never throw（3.4 実装）。registerOTel は OTLP env
  不在ならローカル span のみ。両者とも起動を破壊しないため try/catch 不要（設計上 fail-soft）。
- **registerOTel API 実地確認（P3）**: `@vercel/otel@2.1.3` `registerOTel(optionsOrServiceName?: Configuration | string): void`
  ―― パッケージ docstring canonical 用法に準拠。
- **gate include 外**: instrumentation.ts は apps/web root 直下で 6.1 tsconfig の include（`src` のみ、6.4 境界外）に非含 →
  gate `tsc` 非被覆。isolated tsc + next build 型検査フェーズの 2 系統で健全性を実証（3.4 bootstrap パターン踏襲）。

### 検証エビデンス（Verification Gate）

- **isolated tsc**: `tsc --noEmit --ignoreConfig --strict --moduleResolution bundler --types node instrumentation.ts` → **exit 0**（出力空）。
- **next build**: `✓ Compiled successfully in 16.5s`（instrumentation.ts 含む全体が compile + 型検査通過、失敗は既存 `/_global-error`
  prerender FLAG のみ ―― instrumentation 起因エラーなし）。
- **typecheck**: `mise run typecheck` → **exit 0**。
- **回帰 vitest**: `mise run test:run` → `Tests 17 passed (17)`（回帰なし）。
- **lint**: `mise run lint` → `Checked 45 files … No fixes applied.`（44→45、instrumentation.ts 追加）。
- **audit**: `No known vulnerabilities found`。**lockfile**: `--frozen-lockfile` Already up to date。

### 学び / Act 申し送り

- **Task 6 完了**（6.1–6.4 全緑）: `apps/web` 移設 + route 薄アダプタ化 + OTel Phase 1 起動を確立。`@vaz/*` 全鎖が apps/web
  経由で統合 typecheck され、現行チャット挙動（`streamText`+tools+`isStepCount(5)`、UI stream 形状）を保存（R1.5/1.7）。
- **Task 7 申し送り（重要）**: 旧 root `src/**`（UI + route + `lib/ai`）と `tests/{Chat,chat-schema,provider}.spec.ts` は
  temporary duplication で保持中。7.1 で Vitest projects（web=jsdom / node packages=agents 等）へ収斂 → 収斂後に root `./src`
  撤去（mise の root tsc skip 発火、Task 1.3 想定状態へ）。E2E は 7.2 で `apps/web/tests/e2e` へ移設。7.4 で forbid-model-ids
  grep gate（env carve-out + `@vaz/config` allowlist を除外）。7.5 で既存 build FLAG（`/_global-error`・`/_not-found` prerender、
  React19.2×Next16）を全ゲート緑化前にトリアージ。
- **次**: Task 7（品質ゲート配線 + Phase 1 回帰検証）。

---

## Task 7.1 — Vitest projects 化（web=jsdom / node packages） + apps/web/vitest.config.ts

### Plan（対象・意図）

- **境界**: `vitest.config.ts`（Modify）, `apps/web/vitest.config.ts`（Create）の 2 ファイルのみ。
- **意図（R1.9/NFR-1）**: root Vitest を単一設定から **projects** へ改修し、ワークスペース全体
  （web=jsdom / `@vaz/*` パッケージ=node）を `mise run test:run` で横断集約。従来 `include: tests/**`
  で漏れていた `packages/agents/tests/chat-agent.spec.ts`（5.4, network-free MockLanguageModelV4）を捕捉する。

### Do（実装）

- **root `vitest.config.ts`**: `test.projects` に 3 プロジェクトを定義。
  - `web` = `./apps/web/vitest.config.ts` を path 参照（jsdom, self-contained）。
  - `packages` = node, `packages/*/tests/**`（globals, `@vaz/*` subpath/workspace 解決のみ）。
  - `root-legacy` = jsdom, repo-root `tests/**`（`@→./src` + react plugin + `setupTests.ts`）。
  - coverage は root へ一元化（`src/**`・`src/app/**` 除外・thresholds 80/80 を従来維持）。
- **`apps/web/vitest.config.ts`（新規）**: web=jsdom, `@→apps/web/src` + react plugin。UI テスト移設前は
  0 件のため `passWithNoTests`（意図的空）。standalone `pnpm --filter @vaz/web exec vitest run` も緑。

### 設計判断 / トレードオフ

- **境界厳守 → root-legacy 暫定プロジェクト**: 旧 root `tests/{Chat,chat-schema,provider}.spec.ts` は
  root `./src` 複製（Task 6 temporary duplication）を import。テスト移設・root src 撤去は 7.1 境界外のため、
  「no regression（17 tests 維持）」と「境界厳守（config 2 ファイル）」を両立する暫定被覆として root-legacy を採用。
  UI テストの `apps/web/tests/**` 移設 + `./src` 撤去後に廃止（その時点で web プロジェクトが実テストを持つ）。
- **root 全体 `passWithNoTests` は不採用**: 集約 run が「テストを必ず発見する」安全網を残し、全消失回帰の
  隠蔽を避ける。`--project web` 単独フィルタのみ Vitest 既知挙動で exit 1 になるが、ゲート/ワークフローは
  これを用いず、集約 run（19/19 exit 0）と standalone（exit 0）はともに緑。

### 検証エビデンス（Verification Gate）

- **test:run（projects 横断）**: `mise run test:run` → **`Test Files 4 passed (4) / Tests 19 passed (19)`, exit 0**
  （baseline 3 files/17 → +1 file/+2 tests = agents spec 捕捉）。
- **per-project 確認**: `--project packages` → 2 passed（chat-agent.spec.ts, node）、`--project root-legacy` →
  17 passed（jsdom）、`--project web` → 0 件（意図的空）。
- **typecheck**: `mise run typecheck` → **exit 0**（全 packages + apps/web + root tsc Done）。
- **lint**: `mise run lint` → `Checked 46 files … No fixes applied.`（45→46, apps/web/vitest.config.ts 追加, biome 準拠）。
- **audit**: `No known vulnerabilities found`。**lockfile**: `--frozen-lockfile` Already up to date（config-only, churn ゼロ）。

### 学び / Act 申し送り

- **Task 7.1 完了**: Vitest projects でワークスペース全体を横断集約。`@vaz/agents` の network-free 単体テスト
  （R1.6）が恒久ゲートに載った。root-legacy は暫定で、root `./src`/`tests/*.spec.*` 撤去まで保持。
- **次（7.2/7.3/7.4/7.5）**: 7.2 で Playwright を `--filter @vaz/web` 化 + E2E を `apps/web/tests/e2e/**` へ移設
  （7.1 は `tests/e2e/**` 除外済みで整合）。root-legacy プロジェクト + root `./src` 撤去は UI テスト移設完了後、
  7.5 全ゲート緑化スコープで判断。既存 build FLAG（`/_global-error`・`/_not-found` prerender）は 7.5 前トリアージ。

---

## Task 7.2 — Playwright webServer を --filter @vaz/web 化 + E2E を apps/web/tests/e2e へ移設

### Plan（対象・意図）

- **境界**: `playwright.config.ts`（Modify）, `apps/web/tests/e2e/**`（Create/move）。
- **意図（R1.7/1.9）**: E2E を実 `@vaz/web`（モノレポ移設後アプリ）に対して起動し、既存 E2E を apps/web 配下へ
  移設して回帰ゼロを確認する。

### Do（実装）

- `playwright.config.ts`: `testDir` を `./tests/e2e` → `./apps/web/tests/e2e`。`webServer.command` を
  `pnpm dev`/`pnpm start`（root）→ `pnpm --filter @vaz/web exec next {dev,start} --port ${PORT}`（mise.toml と一致）。
- E2E 2 本（`home.spec.ts`=UI+`/api/chat` Zod 400 検証 5 ケース / `chat-ollama.spec.ts`=ローカル LLM 往復, auto-skip）を
  `apps/web/tests/e2e/**` へ byte-identical 移設（旧 `tests/e2e/**` は削除＝真の move）。

### 設計判断 / トレードオフ

- **真の move（source 削除）を採用**: `tests/e2e/**` への参照は playwright.config.ts の `testDir` のみ（grep 確認）で、
  他境界に消費者なし。7.1 の root-legacy（unit）と異なり temporary duplication 不要 → dead spec を残さず clean に移設。
- **E2E は「実装後の検証」**: tasks 冒頭のテスト規約どおり RED-Green 先行ではなく、移行後の回帰実行で検証。
- **root `next.config.ts`/`./src` は 6.2 の duplication として残存**: root `pnpm dev` も動くが R1.7 は移設後アプリの
  回帰を要求するため `--filter @vaz/web` で実 apps/web を起動（起動元は WebServer ログの instrumentation telemetry で実証）。

### 検証エビデンス（Verification Gate）

- **E2E**: `mise run test:e2e` → **`10 passed / 2 skipped (23.5s)`**（chromium+firefox × home 5 = 10 緑、
  chat-ollama ×2 は `AI_PROVIDER!=ollama` で auto-skip）。テストパスは `apps/web/tests/e2e/...`、WebServer ログに
  apps/web `instrumentation.ts` の Langfuse 未設定警告 → `--filter @vaz/web` 起動を実証。
- **test:run**: `Test Files 4 passed / Tests 19 passed`（回帰なし、e2e は vitest 対象外）。
- **typecheck**: exit 0（全 packages + apps/web + root tsc Done）。
- **lint**: `Checked 46 files … No fixes applied.`（move は net-zero、config 編集のみ）。
- **audit**: `No known vulnerabilities found`。**lockfile**: `--frozen-lockfile` Already up to date。

### 学び / Act 申し送り

- **Task 7.2 完了**: E2E がモノレポ後の実 `@vaz/web` に対して緑。testDir/webServer をワークスペース対応化。
- **次（7.3/7.4/7.5）**: 7.3 で `.githooks/pre-commit`（biome+tsc+vitest+audit を `pnpm -r`/mise 経由）・`pre-push`
  （E2E を `--filter @vaz/web`；旧 `tests/e2e/chat-ollama.spec.ts` コメントの是正含む）。7.4 で forbid-model-ids grep gate。
  7.5 で全ゲート緑化 + Anthropic↔Ollama 等価 + RAG/WF 非混入の回帰検証、既存 build FLAG（`/_global-error`・`/_not-found`
  prerender）トリアージ、root-legacy + root `./src`/`tests/*.spec.*` 撤去の判断。

---

## Task 7.3 — git hooks を mise/workspace 対応へ更新（pre-commit / pre-push）

### Plan（対象・意図）

- **境界**: `.githooks/pre-commit`（Modify）, `.githooks/pre-push`（Modify）。
- **意図（R1.9）**: 単一パッケージ前提の bare `pnpm exec` フックを、モノレポ対応の mise タスク経由へ更新
  （biome + tsc + vitest + audit / pre-push E2E を維持）。

### Do（実装）

- **pre-commit**: `pnpm exec {biome check .,tsc --noEmit,vitest run}` + `pnpm audit` の 4 段を
  `mise run lint`→`typecheck`→`test:run`→`audit` に置換。typecheck は root 単体 tsc → `pnpm -r run typecheck`
  + `[ -d src ]` ガード root tsc（mise.toml 内、移行期の両状態で緑）へワークスペース対応化。
- **pre-push**: `pnpm exec playwright test` → `mise run test:e2e`。Ollama 自動検出 → `export AI_PROVIDER=ollama`
  分岐は維持（mise は親 env を継承）。コメントの旧パスを `apps/web/tests/e2e/chat-ollama.spec.ts` へ是正。

### 設計判断 / トレードオフ

- **mise 経由（bare tool 廃止）**: CLAUDE.md/AGENTS.md「mise.toml が正本 / bare tool を使わない」に整合し、
  guarded typecheck ロジックを mise.toml に一元化（DRY / drift 回避）。task が許す `pnpm -r` 直書きより mise を優先。
- **mise on PATH の安全性**: 現行フックの `pnpm` は mise 管理（`[tools] pnpm=11`）＝mise が PATH 前提。実測
  `command -v mise` → `/opt/homebrew/bin/mise`（Homebrew, shim 非依存）。bare→mise 化は新規リスクなし。
- **model-id ゲートは pre-commit 非包含**: mise.toml の設計（`check` = pre-commit 相当 + model-id, NFR-2）に従い、
  `lint:model-ids` は集約 `mise run check` 側で enforce。pre-commit は「biome+tsc+vitest+audit の 4 段」を厳守。
- **Edit で編集し exec bit 維持**（`-rwxr-xr-x`）。biome は shell 非対象で lint 影響なし。

### 検証エビデンス（Verification Gate）

- **フック実行**: `sh .githooks/pre-commit` → 4 段緑・`[pre-commit] ✅ all checks passed`（test:run 19/19, audit clean）。
  `sh .githooks/pre-push` → **`12 passed (12.7s)`**・`[pre-push] ✅ all checks passed`（Ollama 検出で ollama 分岐実行）。
- **標準ゲート**: `mise run lint` `Checked 46 files … No fixes applied.`、`typecheck` exit 0、`test:run` 19/19、
  `audit` `No known vulnerabilities found`、`--frozen-lockfile` Already up to date。

### 学び / Act 申し送り

- **Task 7.3 完了**: 両フックが mise/workspace 対応で緑。pre-commit=4 段ゲート、pre-push=E2E（@vaz/web webServer）。
- **[FLAG → 7.5]**: pre-push で Ollama 検出下 `12 passed` だが WebServer ログに `model 'llama3.2' not found`。
  `chat-ollama.spec.ts` は `getByText(/pong/i).last()` を assert し、ユーザー入力文（"Reply with … pong"）自体が一致するため
  モデル未取得でも緑（false-green の余地）。7.2 で verbatim 移設した既存仕様の潜在弱点（7.3 非導入・境界外）。
  7.5 の Anthropic↔Ollama 等価検証で、AI 応答を厳密判定するアサーションへの是正を検討。
- **次（7.4/7.5）**: 7.4 で `scripts/forbid-model-ids.sh`（`@vaz/config` allowlist + env carve-out 以外の直書き検出、
  `mise run lint:model-ids`/`check` で enforce）。7.5 で全ゲート緑化 + Anthropic↔Ollama 等価 + RAG/WF 非混入回帰、
  上記 chat-ollama FLAG と既存 build FLAG（`/_global-error`・`/_not-found` prerender）のトリアージ、root-legacy + root `./src` 撤去判断。

---

## Task 7.4 — scripts/forbid-model-ids.sh（モデル ID 直書き検出ゲート, R1.8/ADR-5）

### Plan（対象・意図）

- **境界**: `scripts/forbid-model-ids.sh`（Create）のみ。mise 配線（`lint:model-ids` → `check`）は 1.3 で既存 → 非編集。
- **意図（R1.8/ADR-5）**: モデル ID は `@vaz/config` allow-list を唯一の合法直書き箇所とし、それ以外の直書きを grep で検出し
  lint ステージを失敗させる。

### Do（実装）

- `apps/**`・`packages/**` の `*.ts[x]` を `grep -rEn` で走査し、carve-out を `grep -v` で除外。違反ありなら該当行を出力し exit 1。
- 検出パターン: `claude-[a-z0-9]|llama-?[0-9]|gpt-[0-9]|gemini-[0-9]|qwen[0-9]|mistral-[a-z0-9]`。
- carve-out: `packages/config/**` / `packages/schemas/src/env.ts` / `*.spec.ts[x]` / `**/tests/**`。
- `set -euo pipefail`、スクリプトはルートへ cd。exec bit 付与（`chmod +x`）。

### 設計判断 / トレードオフ

- **走査範囲を apps/packages に限定**: go-forward 構成のみを enforce。root `./src`（legacy duplication, 7.5 撤去予定）は非対象とし、
  transitional path をスクリプトに焼き込まない。root src の env.ts 重複は撤去で自然消滅。
- **検出パターン**: 主軸は claude-/llama（サポート 2 プロバイダ、ADR-5 例示）。非対応他社（gpt/gemini/qwen/mistral）は
  digit 接尾を要求する防御的トリップワイヤ（Provider-Agnostic / OpenAI 非対応の逸脱を捕捉）。現行ツリーで false-positive ゼロを実測確認。
- **mise.toml 非編集**: 1.3 が `lint:model-ids`（`[ -f script ]` ガードで skip→enforce 自動切替）と `check` 依存を先行配線済み。
  script 作成のみで enforce 化＝境界最小。

### 検証エビデンス（Verification Gate）

- **非空虚性（mutation）**: `apps/web/src/__probe_modelid.ts` に `"claude-opus-4-8"` 植込み → **検出 exit 1**（該当行出力）。
  clean tree（config/env に実 ID あり）→ **exit 0**（carve-out 有効）。`.spec.ts` 内 `"llama3.2"` → **非検出 exit 0**。probe 全削除。
- **mise 経由**: `mise run lint:model-ids` → `✅ [forbid-model-ids] … なし`。
- **集約ゲート**: **`mise run check` exit 0**（5 段: `[lint] Checked 46 files … No fixes applied` / `[typecheck]` / `[test:run] 19 passed` /
  `[audit] No known vulnerabilities` / `[lint:model-ids] ✅`）＝ NFR-2 の `clone → install → mise run check` 緑。
- `--frozen-lockfile` up to date。exec bit `-rwxr-xr-x`。

### 学び / Act 申し送り

- **Task 7.4 完了**: モデル ID 直書きゲートが enforce 化。`mise run check`（NFR-2 集約）が model-id を含め全 5 段緑。
- **次（7.5）**: 全ゲート（lint/typecheck/vitest/E2E/audit/model-id）緑を最終確認し、`/api/chat` の Anthropic↔Ollama 切替が
  移行前と等価・RAG/WF 非混入を回帰検証。既存 build FLAG（`/_global-error`・`/_not-found` prerender, React19.2×Next16）と
  7.3 の chat-ollama false-green FLAG をトリアージ。収斂後に root-legacy vitest project + root `./src`/`tests/*.spec.*` 撤去を判断
  （撤去時は forbid-model-ids の走査対象拡大の要否も併せて検討）。

---

## Task 7.5 — Phase 1 回帰検証ゲート（全ゲート緑 / Anthropic↔Ollama 等価 / RAG・WF 非混入）

### Plan（対象・意図）

- **境界**: `apps/web/tests/e2e/**`（Modify/Create）。
- **意図（R1.10/NFR-1/NFR-5）**: 全ゲートを緑にし、`/api/chat` の Anthropic↔Ollama 切替が移行前と等価、Phase 2+（RAG/WF）が
  混入していないことを回帰検証。併せて既知 FLAG（build prerender / chat-ollama false-green）をトリアージ。

### Do（実装）

- **chat-ollama.spec.ts 修正**: (a) skip 条件を「/models 到達」→「対象モデル pull 済み」へ厳格化（`ollamaModelAvailable()` が
  `data[].id` を base 名照合）、(b) アサーションを assistant タイル（`getByText("AI").first().locator("xpath=..")`）にスコープし
  AI 応答に "pong" を要求（ユーザー入力エコーの誤検出を排除）。
- **chat-anthropic.spec.ts 新設**: 対称な guarded 往復 spec（`AI_PROVIDER=anthropic` かつ `ANTHROPIC_API_KEY` 有時のみ実行、
  それ以外は skip）。既定 `test:e2e`（鍵なし）は clean に skip。

### 設計判断 / トレードオフ

- **false-green の根治**: 精密 skip（model 未 pull は skip）+ assistant スコープ assertion で「実往復が起きた時のみ緑」を保証。
  非空虚性を mutation 相当で実証（未 pull 環境で 12 passed→10 passed/4 skipped）。
- **対称 anthropic spec**: プロバイダ切替の等価性を E2E 面でも対称化。鍵は commit せず env/CI secret 供給、既定は skip で
  ゲートを汚さない。切替機構自体は resolveModel（byte-identical 移設）+ provider.spec で単体保証。
- **build FLAG は非対応（境界外・非必須ゲート）**: root cause=React19.2×Next16 の error-page prerender（HEAD 由来・非回帰）。
  7.5 の必須ゲート列に build 非含、修正は e2e 境界外 → フォローアップへ escalate（blind fix しない, error-handling 準拠）。

### 検証エビデンス（Verification Gate）

- **全ゲート**: `mise run check` **exit 0** ―― `[lint] Checked 47 files … No fixes applied` / `[typecheck] 全 Done` /
  `[test:run] Tests 19 passed` / `[audit] No known vulnerabilities` / `[lint:model-ids] ✅`。
- **E2E**: `mise run test:e2e`（既定 anthropic, 鍵なし）**10 passed / 4 skipped**、`mise run test:e2e:ollama`（llama3.2 未 pull）
  **10 passed / 4 skipped**（ollama 往復=精密 skip, false-green 消滅）。
- **build（triage）**: `✓ Compiled successfully` 後 `/_global-error` prerender で `useContext` null → exit 1（HEAD 由来・非回帰）。
- **R1.10**: Phase 2+ dir/file/dep すべて不在（`packages/{rag,evals}`・`apps/worker`・`docker-compose.yml`・rag/workflows/eval/
  supervisor/approval/embedding source・drizzle/pgvector/inngest/temporal/embedMany 参照＝ゼロ）。
- 境界: 変更は `apps/web/tests/e2e/{chat-ollama,chat-anthropic}.spec.ts` のみ。

### 学び / Act 申し送り

- **Task 7 完了（7.1–7.5 全緑）**: ワークスペース品質ゲート配線 + Phase 1 回帰検証を確立。**Phase 1（R1 / NFR-1,2,3,5,6,7）完了**。
- **[FLAG 継続] build prerender**: React19.2×Next16 の `/_global-error`・`/_not-found` prerender。custom error page か Next/React 設定での
  対処を独立タスクで（Phase 2 着手前が望ましい）。
- **[janitorial] root duplication**: root `./src`・`tests/{Chat,chat-schema,provider}.spec.ts`・root `next.config.ts` は temporary
  duplication として残存（root-legacy vitest project + root tsc guard で緑、correctness 無害）。撤去 + root-legacy project 廃止は cleanup で。
- **次**: Task 8（Phase 2: RAG 永続化基盤 ―― postgres+pgvector / @vaz/rag / drizzle schema / embedding resolver / env 拡張 / allowBuilds 監査）。

---

## Task 8.1 — `docker-compose.yml`（postgres+pgvector 開発プロビジョニング, R2.2）

### Plan（対象・意図）

- **境界**: `docker-compose.yml`（Create、単一編集境界）。**Depends**: 7（完了）。**Requirements**: 2.2。
- **意図（R2.2）**: RAG ベクトルストア = PostgreSQL + pgvector を docker-compose で**開発**プロビジョニング。
  拡張 DDL（`CREATE EXTENSION vector`）とスキーマは 8.3（Drizzle migration, `@vaz/rag`）が所有 ―― 本タスクは
  拡張を**利用可能**にするサーバ provision に限定。

### Do（実装）

- `db` サービス = `pgvector/pgvector:pg17`（Postgres 17 + `vector` 拡張バイナリ同梱）。Compose v2 スキーマ
  （obsolete `version:` 不使用、`name: vaz-ai`）。
- 認証情報は env 補間 `${POSTGRES_USER:-vaz}` 等で throwaway default を持ちつつ `.env` 上書き可（後続 DATABASE_URL と
  同一 host:port を指せる）。`pgdata` named volume + `pg_isready` healthcheck（interval 5s / retries 10）、
  ports `${POSTGRES_PORT:-5432}:5432`。
- init SQL script は編集境界外のため追加せず拡張作成を 8.3 に委譲。worker/engine は R3.1 で追記。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: `docker compose config` = RED `no configuration file provided: not found`（file 不在）→
  GREEN merged config を **exit 0** でレンダリング（YAML 構文 / スキーマ / env 補間 / healthcheck / volume / ports 解決）。
- **回帰ゲート**: `mise run lint` = `Checked 53 files … No fixes applied`、`mise run typecheck` **exit 0**、
  `mise run test:run` = **8 files / 31 passed**（回帰なし）。
- **[FLAG] live up-test 未実施（環境制約）**: `docker compose up -d db` は `pgvector/pgvector:pg17` の pull が
  `registry-1.docker.io` へ到達できず `context deadline exceeded`（本 sandbox の外部 egress 制限、image 未キャッシュ）。
  実コンテナ起動 → `CREATE EXTENSION vector` の end-to-end 実証は本セッション不可（compose 定義の不具合ではない）。
  ネットワーク到達可能な開発機で 8.3 migration 適用時に拡張作成を実証する。Rancher Desktop daemon は本検証のため起動。

### 学び / Act 申し送り

- **Task 8.1 完了**: postgres+pgvector 開発サービスを確立（R2.2 の compose 定義）。Phase 2 の RAG 永続化基盤の土台。
- **[申し送り]** 拡張作成（`CREATE EXTENSION vector`）と `vector(768)` 次元固定 DDL は 8.3。既定埋め込み
  Ollama `nomic-embed-text`=768 を初期 N とする（plan Data Model / R2.3）。
- **次**: Task 8.2（`@vaz/rag` package.json）/ 8.3（Drizzle schema）/ 8.4（embedding resolver）/ 8.5（env 拡張）/ 8.6（allowBuilds 監査）。

---

## Task 8.2 — `packages/rag/package.json`（`@vaz/rag` source-only パッケージ定義, R2.1）

### Plan（対象・意図）

- **境界**: `packages/rag/package.json`（Create、単一編集境界 ―― rag package.json は 8.2 のみが編集境界）。
  **Depends**: 7（完了）。**Requirements**: 2.1。
- **意図（R2.1）**: RAG 検索基盤 `@vaz/rag` を workspace member として実体化。ingest/retrieve capability の
  home を確立し、dep グラフ（schemas → config/tools/**rag** → agents → web）へ組み込む。

### Do（実装）

- 2.1/3.1/4.1/5.1 と同型の source-only(JIT) 定義（`type: module` / `sideEffects: false` /
  `exports: { "./*": "./src/*.ts" }` wildcard / `typecheck` echo marker）。
- **前方宣言（resolvable のみ）**: `@vaz/config`(workspace:\*) + `@vaz/schemas`(workspace:\*) +
  `ai`(^7.0.14) + `zod`(^4.4.3) ―― 全て workspace/lockfile 既存で新規外部依存ゼロ。
- **scripts.ingest 先行宣言**: `ingest: "node bin/ingest.ts"`（9.5 の CLI `pnpm --filter @vaz/rag ingest ./docs`,
  R2.6。9.5 境界は bin/ のみで script を追加できないため 8.2 で宣言。Node 24 native TS、file は 9.5 で作成）。
- **[deferred]** `drizzle-orm`/`drizzle-zod`/`pg`（lockfile 未存在の新規外部依存）は 3.1→3.4 の `@ai-sdk/otel`
  deferral 前例に倣い 8.3（drizzle, 境界拡張）+ 8.6（pg の allowBuilds 監査）へ委譲。pgvector 列型は
  drizzle-orm の `vector` を用い別パッケージ不要。

### 検証エビデンス（Verification Gate）

- **RED→GREEN（member 登録）**: `pnpm --filter @vaz/rag run typecheck` = RED `No projects matched the filters`
  （未登録）→ GREEN echo marker 実行（members 5→6）。
- **install**: `pnpm install` = `all 7 workspace projects` / **`downloaded 0, added 0`** / `Lockfile passes
  supply-chain policies`、`pnpm install --frozen-lockfile` = `Already up to date`（churn ゼロ）。
- **回帰ゲート**: `mise run lint` = `Checked 54 files … No fixes applied`（53→54）、`mise run typecheck`
  **exit 0**、`mise run test:run` = **8 files / 31 passed**（回帰なし）。

### 学び / Act 申し送り

- **Task 8.2 完了**: `@vaz/rag` を新規外部依存ゼロで member 化。resolvable deps + ingest CLI script を前方宣言。
- **[申し送り → 8.3]** `drizzle-orm` + `drizzle-zod` を `packages/rag/package.json` へ**境界拡張して追加**
  （3.4 が config/package.json を境界拡張した前例）。schema は `vector(768)`（Ollama `nomic-embed-text` 既定 N）+
  `provider`/`dim` 列で混在検出（R2.2/2.3）。新規 install 時 `minimumReleaseAge:1440`（>24h 版へ解決）を監査。
- **[申し送り → 8.6]** `pg`（および install script を持つ推移的依存）を `pnpm-workspace.yaml` の `allowBuilds` へ
  default-deny(false) で監査追記。未追記だと install がエラー化するため 8.3 の drizzle/pg 宣言と協調が必要。
- **[環境注意]** 新規外部依存の install は npm registry 到達が前提。8.1 で docker registry egress ブロックを確認済み ――
  8.3/8.6 の実 install 前に npm registry 到達性を確認すること。
- **次**: Task 8.3（Drizzle schema, `packages/rag/src/db/schema.ts` + package.json 境界拡張で drizzle 宣言）。

---

## Task 8.3 — `packages/rag/src/db/schema.ts`（Drizzle スキーマ / pgvector, R2.2/2.3）

### Plan（対象・意図）

- **境界**: `packages/rag/src/db/schema.ts`（Create）+ `packages/rag/package.json`（境界拡張、drizzle 宣言）。
  **Depends**: 8.2。**Requirements**: 2.2, 2.3。
- **意図**: document/chunk/embedding の Drizzle スキーマを定義。`vector(N)` を DDL 時に次元固定し、`provider`/`dim`
  列で混在検出の土台を作る（実行時ガードは 9.2）。drizzle-zod で insert/select 契約を単一正本化。

### Do（実装）

- 3 テーブル: `document`(uuid pk/source/metadata jsonb/ingested_at tz) → `chunk`(uuid pk/document_id fk cascade/
  ordinal/content) → `embedding`(chunk_id pk+fk cascade=1:1 / `vector(768)` / dim / provider)。
- `EMBEDDING_DIM = 768`（Ollama `nomic-embed-text` 既定次元）を単一正本 export、`vector(768)` 列 +
  `check("embedding_dim_fixed", sql`dim = 768`)` の双方が参照 ―― 次元不一致を DB 境界で拒否（migration + re-ingest 強制）。
- drizzle-zod `createInsertSchema`/`createSelectSchema` × 3 テーブル。model ID 文字列は非記述（768 整数のみ）。
- **境界拡張（3.4 前例）**: rag/package.json へ `drizzle-orm@^0.45.2` + `drizzle-zod@^0.8.3` を追加。

### 検証エビデンス（Verification Gate）

- **supply-chain**: `pnpm install` = `+2` / `downloaded 2, added 2` / `Lockfile passes supply-chain policies`。
  drizzle-orm 0.45.2 / drizzle-zod 0.8.3（latest stable, 数ヶ月前公開で `minimumReleaseAge:1440` 充足）、
  **lifecycle install script 無し** → `allowBuilds` 追記不要。drizzle-zod peer `zod ^3.25.0 || ^4.0.0` が
  本 repo `zod@4.4.3` と互換（store: `drizzle-zod@0.8.3_..._zod@4.4.3`）。`--frozen-lockfile` = `Already up to date`。
- **RED→GREEN（ephemeral probe, node env, 実行後削除）**: RED = `../src/db/schema` 不在で import 失敗
  （`Test Files 1 failed / no tests`）→ GREEN = **3 passed**（列名 / `EMBEDDING_DIM===768` / drizzle-zod 有効行受理 +
  `source` 欠落拒否）。
- **回帰ゲート**: isolated tsc（`--ignoreConfig --strict --moduleResolution bundler --types node`）**exit 0**、
  `mise run lint` = `Checked 55 files … No fixes applied`（54→55）、`mise run typecheck` **exit 0**、
  `mise run test:run` = **8 files / 31 passed**（probe 削除後・回帰なし）。

### 学び / Act 申し送り

- **Task 8.3 完了**: pgvector スキーマ + drizzle-zod 契約を確立。npm registry は到達可（8.1 の docker registry ブロックとは別系統 ―― 新規 npm 依存の install は本環境で可能と確認）。
- **[申し送り → 9.x]** schema.ts は未 import のため gate typecheck 非被覆（source-only echo marker）。最終被覆は
  9.2 ingest / 9.3 retrieve が `@vaz/rag/db/schema` を import した時点。`provider` 混在の実行時検出（同一次元でも別
  provider を拒否）は 9.2 ingest ガードで実装（静的 CHECK 不能）。`EMBEDDING_DIM` を 9.2 の dim ガードで参照する。
- **[申し送り → 8.6]** `pg`（postgres driver, 9.x の接続で必要）は本タスク非宣言。install script を持つ可能性があり
  `allowBuilds` 監査（8.6, R1.2）と協調が必要。drizzle 2 パッケージは script 無しで先行導入済み。
- **[未検証・環境制約]** 生成 DDL（`CREATE EXTENSION vector` / `vector(768)` / CHECK）の実 PostgreSQL 適用は
  8.1 の pgvector image pull ブロックにより本セッション未実施。型健全性・drizzle-zod 契約は検証済み、DDL 実適用は
  到達可能な開発機での migration（9.x 前）で実証する。
- **次**: Task 8.4（`resolveEmbeddingModel`, `@vaz/config`）/ 8.5（env 拡張）/ 8.6（allowBuilds 監査）は並列可。

---

## Task 8.4 — `packages/config/src/embedding.ts`（`resolveEmbeddingModel`, R2.3）

### Plan（対象・意図）

- **境界**: `packages/config/src/embedding.ts`（Create）。**Depends**: 7（8.5 には非依存＝並列）。**Requirements**: 2.3。
- **意図（R2.3）**: 埋め込みモデルを env 駆動で解決。既定 Ollama `nomic-embed-text`（社内文書がローカルに留まる）、
  shared provider layer（`@ai-sdk/openai-compatible`）経由、`embedMany` で消費される `EmbeddingModel` を返す。

### Do（実装）

- `resolveEmbeddingModel(env = process.env): EmbeddingModel` ―― 3.2 `resolveModel` と同型。`OLLAMA_BASE_URL` は
  `parseAiEnv` で検証済みを再利用、`ollama.embeddingModel(modelId)`（非 deprecated）で構築（lazy, network 非発火）。
- 既定 provider=`ollama` / model=`nomic-embed-text`（`DEFAULT_EMBEDDING_PROVIDER`/`DEFAULT_EMBEDDING_MODEL_ID` を export）。
- **8.5 並列への非依存（3.4 前例）**: `AI_EMBEDDING_PROVIDER`/`AI_EMBEDDING_MODEL` を防御的直読み（空文字→undefined）。
  正式 Zod 検証は 8.5。未対応 provider は fail-fast throw。
- `nomic-embed-text` 直書きは config carve-out（7.4 が `packages/config/**` 全除外、pattern に `nomic` 非含）で合法。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**（ephemeral probe, node env, 削除済）: RED = `../src/embedding` 不在で import 失敗
  （`Test Files 1 failed / no tests`）→ GREEN = **3 passed**（既定 Ollama `nomic-embed-text` を `model.modelId`/
  `model.provider` で network なし assert / `AI_EMBEDDING_MODEL` override / 未対応 provider throw）。
- **回帰ゲート**: isolated tsc（`--ignoreConfig --strict --moduleResolution bundler --types node`）**exit 0**、
  `mise run lint:model-ids` = ✅（ハードコード無し）、`mise run lint` = `Checked 56 files … No fixes applied`（55→56）、
  `mise run typecheck` **exit 0**、`mise run test:run` = **8 files / 31 passed**（probe 削除後・回帰なし）。

### 学び / Act 申し送り

- **Task 8.4 完了**: env 駆動 embedding resolver を確立。`resolveModel`(chat) と `resolveEmbeddingModel`(RAG) が
  同一 provider layer を共有。
- **[申し送り → 8.5]** env schema へ `AI_EMBEDDING_PROVIDER`（Zod enum、既定 `ollama`）+ `AI_EMBEDDING_MODEL`
  （既定 `nomic-embed-text`）を追加し正式検証（R2.3）。8.4 の防御的直読みの既定値と**同値を維持**（R1.8 の env.ts↔allowlist
  duplication と同じ許容パターン、config carve-out）。enum に voyage/openai を将来追加する場合は 8.4 の switch へ branch 追加。
- **[申し送り → 9.2]** ingest は `resolveEmbeddingModel()` を `embedMany({ model, values })` で消費。`@vaz/rag` の
  `EMBEDDING_DIM=768` と embedding provider の実次元の整合を ingest ガードで検証（provider/dim 混在検出）。
- **[環境]** 実 Ollama への embed 往復は本タスク非実施（resolver 構築は lazy）。実往復は 9.x / E2E（`test:e2e:ollama` 相当）で。
- **次**: Task 8.5（env 拡張）/ 8.6（allowBuilds 監査）。

---

## Task 8.5 — `packages/schemas/src/env.ts`（埋め込み env 追加 + Zod 検証, R2.3）

### Plan（対象・意図）

- **境界**: `packages/schemas/src/env.ts`（Modify）。**Depends**: 7（8.4 には非依存＝並列）。**Requirements**: 2.3。
- **意図（R2.3）**: 埋め込みプロバイダ設定を Zod 検証の単一正本（`@vaz/schemas`）へ追加。8.4 resolver の防御的直読みを
  正式スキーマ化し、既定 Ollama・非対応 provider の env 境界 reject を確立。

### Do（実装）

- `aiEnvSchema` へ `AI_EMBEDDING_PROVIDER: z.enum(["ollama"]).default("ollama")` +
  `AI_EMBEDDING_MODEL: z.string().min(1).default("nomic-embed-text")` を追加。
- **`parseAiEnv` 本体にも両フィールド追記**（`emptyToUndefined` 正規化）―― parse は明示キーのみ検証のため必須。
- enum は実装済み provider のみ（`ollama`）。chat `AI_PROVIDER` と同方針、将来 provider は enum + 8.4 switch を同時拡張。
- `nomic-embed-text` は env.ts carve-out（7.4）で合法。既存 ADR-5 drift guard は chat 既定のみ検査で非干渉。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**（ephemeral probe, node env, 削除済）: RED = フィールド不在で既定 undefined・`voyage` 非 reject
  （**4 failed**）→ GREEN = **4 passed**（既定 `ollama`/`nomic-embed-text` / 空文字正規化 / model override /
  `voyage` を Zod reject）。
- **回帰ゲート**: `mise run lint:model-ids` = ✅、`mise run lint` = `Checked 56 files … No fixes applied`、
  `mise run typecheck` **exit 0**、`mise run test:run` = **8 files / 31 passed**（ADR-5 drift guard 含め回帰なし）、
  `pnpm install --frozen-lockfile` = `Already up to date`（新規依存なし）。

### 学び / Act 申し送り

- **Task 8.5 完了**: 埋め込み env を Zod 単一正本へ追加。8.4 resolver（防御的直読み）と 8.5 schema（正式検証）が
  合流し、resolver 内部の `parseAiEnv` 呼び出しが embedding env も fail-fast 検証するようになった。既定値は同値で divergence なし。
- **[申し送り（latent drift）]** 埋め込み既定 `nomic-embed-text` は env.ts ↔ `@vaz/config/embedding.ts` に重複するが、
  chat 既定と違い **drift guard 未整備**（8.5 境界は env.ts のみで config/tests へテスト追加不可）。将来 `model-allowlist.spec.ts`
  へ「env 埋め込み既定 == `DEFAULT_EMBEDDING_MODEL_ID`」の guard を足すと ADR-5 一貫性が完全になる（別タスク推奨）。
- **[申し送り → 9.2]** ingest は `AI_EMBEDDING_PROVIDER` 検証済み env 前提で `resolveEmbeddingModel()` を使用可能。
- **次**: Task 8.6（`pg` 等の `allowBuilds` 監査追記, pnpm-workspace.yaml）で Task 8 完了。

---

## Task 8.6 — `pnpm-workspace.yaml`（`pg` の allowBuilds 監査, R1.2）

### Plan（対象・意図）

- **境界**: `pnpm-workspace.yaml`（Modify）。**Depends**: 7。**Requirements**: 1.2。
- **意図（R1.2）**: Phase 2 DB ドライバ `pg` の install script 有無を監査し、`allowBuilds` へ default-deny で明示記録。

### Do（実装）

- 監査結論: `pg@8.22` は lifecycle build script なし（`scripts` は `test` のみ、依存ツリー純 JS、pg-native 不使用）。
- `allowBuilds` に `pg: false` を追記 + 監査コメント（既存 sharp/@parcel の proactive-deny 慣行に整合、将来 script 追加への
  フェイルセーフ）。allowBuilds が実 pnpm v11 フィールド（matcher→bool map、strictDepBuilds 既定 true）であることを docs で確認。
- `pg` の dependency 追加自体は 9.x（本タスク境界は pnpm-workspace.yaml のみ）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `allowBuilds` に `pg` 不在（grep）→ GREEN = 追記後 `pnpm install` が `Lockfile passes supply-chain
  policies` / `Already up to date`（pg の build prompt・placeholder 自動追記なし、エラー・警告なし）。
- **回帰ゲート**: `pnpm install --frozen-lockfile` = `Already up to date`（allowBuilds は resolution 非影響＝churn ゼロ）、
  `mise run lint` = `Checked 56 files … No fixes applied`、`mise run typecheck` **exit 0**、`mise run test:run` =
  **8 files / 31 passed**、`mise run audit` = `No known vulnerabilities found`。

### 学び / Act 申し送り

- **Task 8.6 完了 → Task 8 全体（8.1–8.6）完了**: Phase 2 RAG 永続化基盤を確立。新規外部依存は drizzle-orm/drizzle-zod のみ
  （いずれも install script 無し）。`pg` は監査済み（script 無し・default-deny 記録）。
- **[申し送り → 9.x]** (1) `pg` を `@vaz/rag/package.json` へ dependency 追加（DB 接続）。install script 無しのため
  strictDepBuilds エラーは出ない見込み。(2) schema.ts/embedding.ts は 9.2/9.3 の import で gate 初被覆。
  (3) 実 PostgreSQL への DDL 適用は 8.1 の image pull ブロックで未実証 ―― migration（drizzle-kit 導入時、
  **esbuild postinstall の allowBuilds 監査が新規に必要**）で実証。(4) embedding 既定 drift guard 未整備（8.5 申し送り）。
- **次**: Task 9（RAG ingest / retrieve capability, Phase 2）。

---

## Task 9.1 — `RetrievedChunk`/`Citation` 契約定義（Phase 2, 2026-07-05）

### Plan（対象・意図）

- **境界**: `packages/schemas/src/rag.ts`（Create）。**Depends**: 8.3。**Requirements**: 2.4。
- **意図（R2.4）**: retrieve 経路（9.3）が返す型付きヒット単位と、chat agent（9.6）が回答へ提示する引用参照を、
  schemas leaf に単一正本として定義。9.2/9.3/9.4/9.6 が共有する契約層を先行確立。

### Do（実装）

- `retrievedChunkSchema`（`chunkId`/`documentId`=`z.uuid()`, `source`=`min(1)`, `ordinal`=`int().nonnegative()`,
  `content`, `score`=`z.number()`）+ `citationSchema`（`documentId`/`source`/`chunkId` のみ）+ `z.infer` 型
  `RetrievedChunk`/`Citation`。
- 純関数 `toCitation(chunk)` を同梱＝projection を単一正本化（9.4/9.6 が再実装しない、content/score 非携行）。
- identity 列は 8.3 Drizzle `uuid`（document.id/chunk.id）に接合、`ordinal` は chunk.ordinal（int notNull）に対応。
- `score` は range 非拘束（実レンジは retrieve 9.3 所有、clamp は誤 reject リスク）。`content` の R5.2 区切り注入は
  agent 責務＝本 module は型付けのみ。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/schemas/tests/rag.spec.ts` →
  `Cannot find package '@vaz/schemas/rag'` / `no tests`（module 不在）→ GREEN = **11 passed**（well-formed 受理 /
  非 UUID documentId・chunkId reject / 負・非整数 ordinal reject / 空 source reject / `toCitation` projection・
  content/score 非漏洩）。
- **回帰ゲート**: `mise run test:run` = **9 files / 42 passed**（8/31 → 9/42、回帰なし）、`mise run typecheck` **exit 0**、
  `mise run lint:model-ids` **✅**（model 文字列非含）、`mise run lint` = `Checked 58 files … No fixes applied`
  （初回 100char 超の 1 行を `lint:fix` で wrap＝formatting のみ、logic 変更なし）。

### 学び / Act 申し送り

- **durable test 境界の判定**: schemas は chat.spec.ts と同型の durable test 境界を持つ（config/rag 8.x の ephemeral
  probe とは異なる）ため durable `packages/schemas/tests/rag.spec.ts` を作成。以後 schemas の src 追加は durable test で進める。
- **[申し送り → 9.2/9.3/9.4]** (1) retrieve 9.3 は `retrievedChunkSchema` の全フィールド（特に normalized `score`）を満たす
  形で返すこと。(2) 9.4 tool は `toCitation` を用いて Citation を生成（再 projection 禁止）。(3) gate typecheck は
  source-only echo marker のため rag.ts 非被覆 → 9.2/9.3/9.4 の import で初被覆。
- **次**: Task 9.2（`src/ingest/index.ts` loader→chunk→embed→upsert、provider/dim ガード付き）。

---

## Task 9.2 — RAG ingest path（loader→chunk→embed→upsert + provider/dim guard, Phase 2, 2026-07-05）

### Plan（対象・意図）

- **境界**: `packages/rag/src/ingest/index.ts`（Create）＋ `packages/rag/package.json` 境界拡張（`pg` 依存, 8.3 前例）。
  **Depends**: 8.3, 8.4, 9.1。**Requirements**: 2.1, 2.6（+ guard は 2.2/2.3）。
- **意図**: コーパス取り込み経路を実装。8.3 schema.ts が「provider 混在の runtime 検出」を委譲した ingest ガードを本タスクで実装。

### Do（実装）

- ADR-3 deps-closure で orchestrator を注入シーム上に構成: `ingest(corpusPath, deps)`、`deps`={store(port), embed, loadCorpus?, chunk?, logger?}。
- 純関数 export: `chunkText`（固定長 window+overlap, 決定的・全域被覆）/ `assertEmbeddingConsistency`（count + dim===768 + 各 vector 長）/
  `assertNoProviderMixing`（既存 profile 相違で throw）。
- adapters: `createDrizzleIngestStore(db)`（driver-agnostic `PgDatabase`、tx で source 単位 delete→insert 冪等 upsert）/
  `createEmbedder`+`createDefaultEmbedder`（`resolveEmbeddingModel`+`embedMany`, lazy）/ `defaultFileCorpusLoader`（`.md/.mdx/.txt` 再帰）。
- `@vaz/rag/package.json` に `pg@^8.13.1`（dep）+ `@types/pg@^8.11.10`（devDep）追加。ingest は driver-agnostic 型で pg 非 import だが
  DB 書込 adapter 初出＝ドライバ宣言所有者。install script 無し（8.6 監査済 pg=false は inert）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/rag/tests/ingest.spec.ts` → `@vaz/rag/ingest/index` 未解決 /
  `no tests` → GREEN = **15 passed**（chunkText 4 / consistency 4 / mixing 3 / orchestrator 3 / FS loader 1）。
- **回帰ゲート**: `mise run test:run` = **10 files / 57 passed**（9/42 → 10/57、回帰なし）、isolated tsc（`--ignoreConfig --strict
  --module esnext --target es2022 --moduleResolution bundler --verbatimModuleSyntax --types node packages/rag/src/ingest/index.ts`）
  **exit 0**、`mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 60 files … No fixes applied`
  （初回 import 順 + 100char wrap の 2 file を `lint:fix` 整形＝formatting のみ）、`pnpm install` = `+17`/supply-chain pass、
  `--frozen-lockfile` = `Already up to date`、`mise run audit` = No known vulnerabilities。

### 学び / Act 申し送り

- **guard は durable test で残す**: 8.x は宣言的で ephemeral probe を採用したが、provider/dim guard は安全性クリティカル（data-integrity）
  かつ ingest は実ロジックのため durable `packages/rag/tests/ingest.spec.ts` を採用。以後 rag の src 実装は durable test で進める。
- **[申し送り → 9.3]** retrieve は `createDrizzleIngestStore` と同じ driver-agnostic `PgDatabase` 型で DB を受け、`cosineSimilarity`
  （`ai` から export 済）or pgvector `<=>` でベクトル検索。`RetrievedChunk`（9.1）の全フィールド（正規化 score 含む）を満たして返す。
- **[申し送り → 9.5]** bin/ingest.ts は `Pool`(pg) → `drizzle(pool,{schema})` → `createDrizzleIngestStore` + `createDefaultEmbedder` を配線し
  `ingest(path, {store, embed})` を呼ぶ。実 DB/Ollama end-to-end はここで初実証（8.1 image-pull FLAG により本セッション未実証）。
- **次**: Task 9.3（`src/retrieve/index.ts` reranker なしベクトル検索）。

---

## Task 9.3 — RAG retrieve path（reranker なしベクトル検索, Phase 2, 2026-07-05）

### Plan（対象・意図）

- **境界**: `packages/rag/src/retrieve/index.ts`（Create）。**Depends**: 8.3, 9.1。**Requirements**: 2.1, 2.7。
- **意図**: reranker なしのベクトル検索を実装し、9.1 `RetrievedChunk` 契約で結果を返す。9.4 tool / 9.6 chat の検索基盤。

### Do（実装）

- 9.2 と同型に注入シーム上で構成: `retrieve(query, deps)`、`deps`={store(`RetrievalStore` port), embedQuery, topK?, logger?}。
- store は SQL で最近傍走査（pgvector `<=>`, ORDER BY 距離 LIMIT k, index-backed）。orchestrator は `distanceToScore = 1 - distance`
  で cosine 距離 → similarity（大きいほど類似, 9.1 契約）変換し **score DESC 再ソート**で most-similar-first を保証。
- 空/空白クエリは embed/search せず `[]`。query vec 次元 ≠ EMBEDDING_DIM / 非正 topK は fail-fast。既定 `DEFAULT_TOP_K=5`。
- adapters: `createDrizzleRetrievalStore(db)`（driver-agnostic `PgDatabase`、`cosineDistance(...).mapWith(Number)` + embedding⋈chunk⋈document）、
  `createDefaultQueryEmbedder(env)`（`resolveEmbeddingModel`+`embed`, lazy）。新規依存なし（9.2 で pg 導入済）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/rag/tests/retrieve.spec.ts` → `@vaz/rag/retrieve/index` 未解決 /
  `no tests` → GREEN = **7 passed**（distanceToScore / 空クエリ no-embed / 距離→score + 順序保証 + `retrievedChunkSchema` 適合 /
  topK 既定・override / vector 転送 / 次元不一致 throw / 非正 topK throw）。
- **回帰ゲート**: `mise run test:run` = **11 files / 64 passed**（10/57 → 11/64、回帰なし）、isolated tsc（`--ignoreConfig --strict
  --module esnext --target es2022 --moduleResolution bundler --verbatimModuleSyntax --types node packages/rag/src/retrieve/index.ts`）
  **exit 0**（`cosineDistance`/`eq`/join 型・`.mapWith(Number)` の distance:number 解決）、`mise run typecheck` exit 0、
  `mise run lint:model-ids` ✅、`mise run lint` = `Checked 62 files … No fixes applied`（import 名順 1 file を `lint:fix`＝formatting のみ）、
  `--frozen-lockfile` clean。

### 学び / Act 申し送り

- **順序契約を store から分離**: orchestrator が score DESC で再ソートするため、store の ORDER BY が壊れても「most-similar-first」は保たれる
  （contract を実装詳細から守る防御的設計）。
- **[申し送り → 9.4]** `createRetrievalCapability(deps)` は `retrieve(query, {store, embedQuery, topK})` を呼び、`RetrievedChunk[]` を
  `tool()` の出力に整形。引用は 9.1 `toCitation` で `Citation` を生成。deps.db（Drizzle）から `createDrizzleRetrievalStore` を構築。
- **[申し送り → 9.6]** chat agent は retrieval capability をツール登録し、結果を R5.2 の明示区切りコンテキストブロックとして注入（system prompt 非混入）。
- **次**: Task 9.4（`src/tools.ts` `createRetrievalCapability`）。

---

## Task 9.4 — RAG retrieval capability（createRetrievalCapability, Phase 2, 2026-07-05）

### Plan（対象・意図）

- **境界**: `packages/rag/src/tools.ts`（Create）。**Depends**: 9.3, 9.1。**Requirements**: 2.4。
- **意図**: retrieve を chat agent 向けの `tool()` capability として export。`RetrievedChunk`/`Citation` を返し引用付き回答を可能に。

### Do（実装）

- `createRetrievalCapability(deps, options?)`＝`createTimeCapability` の capability パターン + `createChatAgent` の seam 慣行。
  `{ searchDocuments: tool(...) }` を返す。`options.store`/`embedQuery` は test seam（既定は `deps.db` から
  `createDrizzleRetrievalStore` + `createDefaultQueryEmbedder`）。`RagDatabase = PgDatabase<PgQueryResultHKT>` を export（9.6 用）。
- inputSchema = `{ query: min(1), topK?: int().positive().max(20) }`。execute → `retrieve()` → `{ chunks, citations }`
  （citations = `chunks.map(toCitation)`、1:1 projection）。topK 優先: per-call → options 既定 → DEFAULT_TOP_K(5)。
- privacy: execute は raw query 非ログ（deps.ts PRIVACY CONTRACT）。model 文字列非含。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/rag/tests/tools.spec.ts` → `@vaz/rag/tools` 未解決 /
  `no tests` → GREEN = **4 passed**（tool 露出 + inputSchema query 必須 / chunks+citations が 9.1 契約適合・most-similar-first・
  citation projection / 空マッチ `{chunks:[],citations:[]}` / per-call topK が construction 既定を上書き）。
- **回帰ゲート**: `mise run test:run` = **12 files / 68 passed**（11/64 → 12/68、回帰なし）、isolated tsc（`--ignoreConfig --strict
  --module esnext --target es2022 --moduleResolution bundler --verbatimModuleSyntax --types node packages/rag/src/tools.ts`）
  **exit 0**、`mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 64 files … No fixes applied`
  （import 順 + tool 定義 wrap の 1 file を `lint:fix`＝formatting のみ）。

### 学び / Act 申し送り

- **execute の直接呼出**: `tool().execute` の第 2 引数（`ToolCallOptions`）は本 execute が不使用のため、test では input 1 引数で
  直接呼び runtime 検証（options 型の再現不要）。以後の capability test でも同手法を再利用可。
- **[申し送り → 9.6]** `createChatAgent(deps)` は `createRetrievalCapability(deps)` の `searchDocuments` を time ツールに追加登録。
  deps.db は Drizzle client（`RagDatabase`）を要するため、AgentDeps の DB generic を narrow（現状 chat 経路は db=null のため
  env/deps 駆動で後方互換に：capability 登録は db 有無で条件分岐 or deps 経由 opt-in）。tool 結果は R5.2 明示区切りブロックとして注入
  （system prompt 非混入）、R5.3（外部読取駆動ターンでの破壊的ツール抑制）は Phase 3 の approval-policy に接続。
- **次**: Task 9.5（`bin/ingest.ts` CLI エントリ）。


---

## Task 9.5 — RAG ingest CLI（bin/ingest.ts, Phase 2, 2026-07-05）

### Plan（対象・意図）

- **境界**: `packages/rag/bin/ingest.ts`（Create）。**Depends**: 9.2。**Requirements**: 2.6。
- **意図**: `pnpm --filter @vaz/rag ingest <path>` で end-to-end 取り込みできる composition root を実装。

### Do（実装）

- `main(argv, env)` で `Pool`→`drizzle(pool)`→`createDrizzleIngestStore` + `createDefaultEmbedder` を配線し `ingest()` を呼ぶ。
- pure 関数 export（testable）: `parseIngestArgs`（corpus path）/ `resolveDatabaseUrl`（DATABASE_URL fail-fast）/ `createConsoleLogger`。
- `import.meta.main`（Node 24.18 stable）で entry guard → test import 時に main 非実行（DB 非接続）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/rag/tests/ingest-cli.spec.ts` → `../bin/ingest` 未実装 /
  `no tests` → GREEN = **8 passed**（parseIngestArgs 4 / resolveDatabaseUrl 3 / createConsoleLogger 1）。
- **回帰ゲート**: `mise run test:run` = **13 files / 76 passed**（12/68 → 13/76、回帰なし）、isolated tsc（rag src 4 + bin）**exit 0**、
  `mise run typecheck` exit 0、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 66 files … No fixes applied`、`--frozen-lockfile` clean。
- **実 CLI**: `node packages/rag/bin/ingest.ts`（no-args）→ usage エラー exit 1、path のみ（DATABASE_URL 無）→ DATABASE_URL エラー exit 1
  ＝module chain 完全解決 + 引数/env バリデーション到達。

### 学び / Act 申し送り（重要）

- **[根本原因→修正] Node native ESM と拡張子なし相対 import の非互換**: 実 `node bin/ingest.ts` 実行で `../db/schema` 等の拡張子なし
  相対 import が `ERR_MODULE_NOT_FOUND`。repo 規約は拡張子なし相対 import（vitest/Turbopack は解決、Node native ESM は拡張子必須）。
  bin が初の直接 node エントリのため顕在化。**修正**: `@vaz/rag` の intra-package import を self-referencing `@vaz/rag/*`（exports map が
  `.ts` 付与）へ統一（`ingest/index`・`retrieve/index`・`tools.ts`）。tsc/vitest/Turbopack/Node 全てで解決。**将来 `@vaz/rag` 以外を
  node 直実行する場合も同パターンを適用**（現状 agents/tools/config/schemas は Turbopack/vitest 経由のみで顕在化せず）。
- **[deferred] 実 corpus 取り込み**（実 Postgres+pgvector upsert / Ollama 埋め込み）は 8.1 image-pull ブロックで未実証 → 到達可能環境で
  `DATABASE_URL` + Ollama 下に `pnpm --filter @vaz/rag ingest ./docs` 実行して実証（10.x recall@k がこの corpus を利用）。
- **[申し送り → 9.6]** 最後の Task 9 サブタスク。`createChatAgent(deps)` に `createRetrievalCapability(deps)` の `searchDocuments` を
  追加登録。deps.db を Drizzle client(`RagDatabase`)へ narrow、tool 結果は R5.2 明示区切りブロックで注入（system prompt 非混入）。
- **次**: Task 9.6（`packages/agents/src/chat-agent.ts` に RAG retrieval capability を登録）。

---

## Task 9.6 — chat-agent へ RAG capability 登録（Phase 2, 2026-07-05）

### Plan（対象・意図）

- **境界**: `packages/agents/src/chat-agent.ts`（Modify）＋ `agents/package.json` に `@vaz/rag` dep 追加。**Depends**: 9.4。**Requirements**: 2.4。
- **意図**: `createChatAgent(deps)` が RAG retrieval capability をツール登録し引用付き回答を可能に。env/deps 駆動で Phase 1 後方互換（R1.7）。

### Do（実装）

- 純関数 `buildChatTools(deps, options)` を export（登録判定を stream なしで検証可能）。`getCurrentTime` 常時 + `searchDocuments`（9.4）を
  「retrieval 注入 or `deps.db != null`」時のみ登録。`options.retrieval` seam（`model` seam と同型）追加。
- 単一 `ToolSet` record を構築（union 回避）。`deps as AgentDeps<RagDatabase>` は ADR-3 の composition-boundary アサーション。
- `agents/package.json` に `@vaz/rag: workspace:*` 追加（dep graph 整合、link のみ）。tool 結果 `{chunks, citations}` は system prompt 非混入（R5.2）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/agents/tests/chat-agent-rag.spec.ts` → `buildChatTools`/seam 未実装（4 failed）→
  GREEN = **4 passed**（db:null→time のみ / db present→searchDocuments（deps 駆動）/ retrieval 注入で登録 / mock model の searchDocuments 呼出で
  capability 実行し `{chunks, citations}` 1:1 返却）。既存 chat-agent.spec.ts 2 tests も緑（R1.7）。
- **回帰ゲート**: `mise run test:run` = **14 files / 80 passed**（13/76 → 14/80、回帰なし）、**`mise run typecheck` exit 0（apps/web tsc が
  agents→rag→retrieve→schema を実型検査＝rag src の初 gate 被覆）**、`mise run lint:model-ids` ✅、`mise run lint` = `Checked 67 files … No fixes applied`、
  `--frozen-lockfile` = Already up to date、`mise run audit` = No known vulnerabilities。

### 学び / Act 申し送り

- **[根本原因] ToolSet union 型エラーを apps/web tsc が初検出**: `{time} | {time,search}` union は `ToolSet`（`Record<string, Tool&...>`）非適合
  （union の searchDocuments が `Tool | undefined`）。単一 ToolSet record 構築で解決。9.6 で apps/web tsc が rag チェーンを初めて実型検査した価値
  ＝source-only echo marker では拾えない型不整合の最終防波堤（今後 rag を変更したら apps/web tsc が gate）。
- **[Task 9 完了]** 9.1–9.6 全緑。RAG capability（契約→ingest→retrieve→tool→CLI→chat 登録）確立。**FLAG（未解決・継続）**: 実
  Postgres+pgvector/Ollama への end-to-end は 8.1 image-pull ブロックで未実証 → 到達可能環境で実証（Task 10 recall@k が実証点）。
- **[申し送り → Task 10]** recall@k は 20–50 件 question→期待 docID の golden set（10.1）+ 埋め込みのみ（LLM 非依存）の recall@k テスト（10.2）。
  9.3 `retrieve` / 9.2 `ingest` を実 DB で駆動する初の統合＝ここで RAG end-to-end を実証。到達可能環境（DATABASE_URL + Ollama）前提。
- **次**: Task 10.1（golden-set.json）。

---

## Task 10.1 — recall@k ゴールデンセット fixture（Phase 2）

### Do（実施）

- `packages/rag/tests/fixtures/golden-set.json`（新規）を作成。**14 docs corpus + 30 questions**（R2.5 の 20–50 内）を
  単一ファイルに同梱した **self-contained 設計**。各 question に `expectedDocumentIds`、トップレベルに `k`(=5) と `description`（消費手順）。

### 設計判断（Why）

- **なぜ corpus 同梱か**: `document.id` は `uuid().defaultRandom()`（8.3）で ingest 時ランダム採番 → 外部 corpus 参照だと CI で
  docID が非決定的。10.1 の編集境界は `golden-set.json` **1 ファイルのみ**で、安定 docID を固定できる唯一の場所がここ。よって
  corpus（安定 UUID `id` + `source` + `content`）と questions を同梱し、埋め込みのみ・LLM 非依存・CI 決定的な recall@k を成立させた。
- `id` は valid UUID＝`retrievedChunkSchema.documentId`（`z.uuid()`, 9.1）と `rag.ts:22`「score recall@k by document ID」に整合。
- corpus は実プロジェクト知識（stack/monorepo/request-flow/provider/DI/model-id/AI SDK v7/testing/telemetry/Carbon/RAG
  ingest・retrieve・schema・chat-agent tool）を doc あたり 1 トピックで弁別可能に構成。q29/q30 は 2 doc 期待で多重被覆も表現。

### 検証エビデンス（Verification Gate）

- **不変条件（ephemeral node validator, 検証後削除）**: JSON well-formed / 全 docID・expectedID が valid UUID / expectedID が
  corpus doc に解決 / id・question id 重複なし / question 数 30（20–50 内）/ k≥1 → **OK: 14 docs, 30 questions, k=5**。
- **回帰ゲート**: `mise run lint` = Checked **68 files** / No fixes applied（JSON も biome tab 準拠）、`mise run lint:model-ids` ✅
  （model-id リテラル非含）、`mise run typecheck` exit 0（fixture は JSON＝非型検査、回帰なし）、`mise run test:run` =
  **14 files / 80 passed**（Task 9 から回帰なし、10.2 未実装のため fixture は未消費）。

### 学び / Act 申し送り

- **TDD 除外の根拠明示**: recall@k は tasks.md L16–17「post-impl 検証」規定で RED-GREEN 対象外。代替として ephemeral node
  validator で不変条件を実証（fixture は 10.2 の recall.spec.ts が durable に消費・検証する）。
- **[申し送り → 10.2]** recall.spec.ts は本 fixture の corpus を各 doc の**明示 `id`** で store へ seed（`ingest()` は random id
  を強制するため insert seam を用いる）→ chunk/question を configured embedding model で埋め込み → `retrieve`（9.3）→ 返却
  `documentId` を `expectedDocumentIds` と突合し recall@k 算出。**FLAG（継続）**: 実 embedding/pgvector 経路の実証は 10.2 +
  到達可能環境（DATABASE_URL + Ollama、8.1 image-pull FLAG 解消後）。
- **次**: Task 10.2（recall.spec.ts）。

---

## Task 10.2 — recall@k テスト（`recall.spec.ts`, Phase 2）

- **日時**: 2026-07-06
- **Requirements**: 2.5
- **Boundary**: `packages/rag/tests/recall.spec.ts`（単一ファイル、境界厳守）

### Do（実施）

- `packages/rag/tests/recall.spec.ts`（新規）を **2 層**で実装。
  - **(1) 決定論層（常時 CI 実行・ネットワーク非依存）**: `recallForQuestion`/`distinctDocIds`（純関数の recall@k 採点）を
    full-hit / partial（2 doc 中 1）/ perfect / miss / 空 expected の各ケースで assert。加えて golden-set fixture 契約
    （k≥1・questions 20–50・docID 一意 valid UUID・全 question の expectedDocumentIds が corpus doc に解決）を検証し、
    10.1 fixture を durable に消費。
  - **(2) 実 embedding 統合層（gated）**: configured embedder（`createDefaultEmbedder`/`createDefaultQueryEmbedder`）で
    corpus/question を埋め込み（**埋め込みのみ・LLM 非依存**, R2.5）→ **in-memory cosine-NN store**（pgvector `<=>` と同一の
    `1 − cosθ` 距離）へ **各 doc の明示 `id`** で seed（ingest の random-id を迂回＝10.1 配線契約）→ `retrieve`（9.3, topK=k）
    → 返却 documentId を expectedDocumentIds と突合し mean recall@k を算出、`MIN_MEAN_RECALL=0.8` を assert。

### 設計判断（Why）

- **DB-free 統合 + honest auto-skip**: 実 Postgres/pgvector は持ち込まず、cosine 距離を JS で再現した in-memory store で
  `retrieve` を駆動（`@vaz/rag` unit suite の DB-free 規律を維持）。測定対象＝configured embedding の corpus 弁別能であり、
  NN スキャンが SQL か JS かに非依存（同一 cosine 数学）。統合層は **embedding model 到達性で auto-skip**（Ollama `/models`
  を 2s probe し解決モデル ID の存在を確認 ―― chat E2E と同一の honest-skip）→ model 未 pull の CI では skip、到達可能環境
  では実行。model ID は `@vaz/config/embedding#DEFAULT_EMBEDDING_MODEL_ID` から取得（直書きなし。test は forbid-model-ids
  carve-out でもある）。
- **なぜ 2 層か**: recall@k は tasks.md L16–17「post-impl 検証」で RED-GREEN 除外。決定論層が採点ロジックの非空虚性を CI で
  常時保証（メトリックが壊れれば即赤化）、統合層が実 embedding の end-to-end を実証。両立で「CI で実行」（常時緑）と
  「実 embedding 経路の実証」（到達環境で実測）を同一ファイルで達成。

### 検証エビデンス（Verification Gate）

- **[FLAG 解消・実測] 実 embedding recall@k**: `nomic-embed-text`（768-dim = EMBEDDING_DIM）を pull した到達可能環境で統合層を
  実行 → **mean recall@5 = 1.000 / 30 questions（全問 perfect、q29/q30 の 2-doc 期待含む）**。閾値 0.8 を大きく上回る。
  実行時間 ~2.5s（14 docs + 30 queries の実埋め込み）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **15 files / 87 passed**（14/80 → +1 file / +7 tests、回帰なし。統合層は Ollama 到達環境で実行）。
    model 未 pull 環境では該当 1 test が skip（6 passed / 1 skipped）で CI 緑を維持することも確認済み。
  - `mise run typecheck` exit 0（`apps/web tsc` が agents→rag→retrieve/ingest/schema を実型検査）。
  - `mise run lint` = Checked **69 files** / No fixes applied（初版の行折返しは `lint:fix` で決定論的整形、logic 不変）。
  - `mise run lint:model-ids` ✅（test carve-out + config 委譲で直書きなし）。

### 学び / Act 申し送り

- **[Task 10 完了]** 10.1–10.2 全緑。self-contained golden set + 2 層 recall.spec を確立し、**mean recall@5 = 1.000** を実測して
  Task 8/9 から継続の「実 embedding 経路の recall@k 未実証」FLAG を解消。
- **[環境メモ]** 統合層の実行には embedding model の pull が必要（本セッションで `ollama pull nomic-embed-text` 実施）。CI /
  未 pull 環境では auto-skip となり緑を維持 ―― 実測を再現するには到達可能な Ollama + `nomic-embed-text`（または 768-dim 互換の
  `AI_EMBEDDING_MODEL`）を用意する。
- **[残 FLAG]** 実 Postgres/pgvector 経路（`createDrizzleRetrievalStore` の SQL NN）の end-to-end は本タスクでは in-memory
  store で代替（DB-free 規律）。SQL NN の実 DB 実証は 8.1 image-pull 解消後の別検証点に残る（recall 値は数学的に同一のため
  品質メトリックとしては本タスクで充足）。
- **次**: Phase 3（Task 11: 耐久エンジンスパイク Inngest vs Temporal + ワークフロー契約）。

---

## Task 10R — アドバーサリアルレビュー由来ハードニング（Phase 2 remediation, 2026-07-06）

Task 8–10 完了後の `/code-review`(high) + `/adversarial-review` の指摘5件のうち #7/#1 を TDD 実装。
#3/#4/#5 は Task 8.1 FLAG（実 DB + drizzle-kit）を前提とするため authored pending（10R.3–10R.5）。

- **#7（10R.1）buildChatTools 登録述語の厳格化**: `db != null` → Drizzle duck-type（`isRagDatabase`＝
  `select` 関数）。narrow 後の `{ ...deps, db }` で旧 `deps as AgentDeps<RagDatabase>` 無検査キャストを除去。
  RED（非 Drizzle truthy db が `searchDocuments` を登録）→ GREEN（`getCurrentTime` のみ）。既存 positive
  テストは `db:{select(){}}` に更新。
- **#1（10R.2）埋め込み provenance に model を追加**: `embedding.model text notNull` + `EmbeddingProfile`/
  `EmbedBatch`/`DocumentUpsert` へ model 伝播 + `createEmbedder`=`model.modelId`。`assertNoProviderMixing`
  を provider+model+dim に。retrieve 側は optional `getEmbeddingProfile` + `queryProvenance` ガードを追加し、
  同一次元・別モデルの無言破壊を read/write 双方で拒否。`tools.ts` は default embedder 使用時のみ env から
  queryProvenance を lazy 解決（直前修正 #6 の遅延性を維持、注入 embedQuery のテストでは guard no-op）。
  RED（同一 provider/dim・別 model が通過）→ GREEN（ingest/retrieve 双方で throw）。
- **検証ゲート**: `pnpm exec vitest run` = 15 files / **93 passed**（89→93、回帰なし）、`mise run typecheck`
  = apps/web tsc **Done**（`@vaz/rag`/`@vaz/agents` を推移的に型検査、`model.modelId` 含む型伝播 OK）、
  `mise run lint` = Checked 69 / No fixes、`mise run lint:model-ids` ✅。build は既存 FLAG（`/_not-found`
  prerender、HEAD 由来・非回帰）につき本 remediation 非対象。
- **[8.1 FLAG] deferral（#3/#4/#5 + 10R.2 の DDL 適用）**: 本環境は (a) pgvector image-pull 不可、
  (b) Ollama 到達不可、(c) drizzle-kit 未導入（`embedding.model`/`unique(source)` の DDL 適用手段が無い）。
  10R.3（UNIQUE source）/10R.4（DISTINCT provenance）/10R.5（route→DB 配線）は実 DB + drizzle-kit 導入
  （esbuild postinstall の allowBuilds 監査を伴う）前提。10R.2 の列も DDL 適用は 8.1 後（現状は Drizzle
  スキーマ定義 + guard ロジックのみ＝8.3/9.2 と同一の source-only 検証規律）。
- **[cleanup 申し送り]** env 空文字正規化（`readEnv`/`emptyToUndefined`/inline `||`）と provider/model 派生の
  重複（`tools.ts#resolveQueryProvenance` ↔ `createDefaultEmbedder`）はレビュー #C1/#9 として残置。将来
  `resolveEmbeddingModel` を `{ model, provider }` 返却に単一化して解消する。

---

## Task 11.1 — 耐久エンジンスパイク（Inngest vs Temporal 確定, Phase 3, 2026-07-06）

### Plan（対象・意図）

- **目的**: ADR-2 / Clarification Q2 を解消。Phase 3 の外部耐久ワークフローエンジンを Inngest と Temporal (TS SDK) で
  実装比較し確定する（R3.2）。以降 Task 11.2〜14 の前提。
- **Boundary**: `docs/spikes/phase3-durable-engine.md`（単一ドキュメント、境界厳守）。`_Requirements:_` 3.2。
- **性質**: `src/` ユニットロジックなし = TDD RED-GREEN 非該当（tasks.md L16–17 規約どおり）。成果物は「3 軸比較 +
  確定結論」の意思決定ドキュメント。検証ゲート＝要件充足 + リポジトリ回帰なし。

### Do（実施）

- `docs/spikes/phase3-durable-engine.md`（新規）を作成。4 判定軸で実装レベル比較 → 確定:
  - **軸 A 中断/再開・HITL（R3.4/3.5/3.8）**: Inngest `step.waitForEvent({ match, timeout: "7d" })` が
    「相関付き・期限付き・日跨ぎ中断→イベント再開」を 1 プリミティブで表現（**Inngest 優位**）。Temporal は
    Signal + `condition()` + `continueAsNew` で同等だが記述量・determinism 規約負荷が高い。両者コードスケッチ掲載。
  - **軸 B 再起動跨ぎ耐久（R3.7）**: 両者構造的に充足（Inngest=永続 step + memoize / Temporal=event-sourced replay）。
    保証強度は Temporal がやや上だが R3.7 要件は Inngest で十分（**引き分け**）。
  - **軸 C web↔worker 分離（R3.2）**: Inngest は `inngest.send()` の event 投入で分離がタダ、11.2 の `JobEvent`
    union と同型（**Inngest 優位**）。Temporal は task-queue poll。
  - **軸 D 進捗/可観測性（R3.6）**: Inngest Realtime が SSE に直結（僅差優位）。
  - **決定的軸 = 運用フットプリント（§7）**: Inngest=単一バイナリ + 既存 Postgres + Redis + Connect(WS :8289)。
    Temporal=multi-service クラスタ + 専用永続 DB(+ES) + determinism/patching 規律 → 内部ツール規模に過剰。
- **結論**: **Inngest（TS SDK / self-hosted）を採用**。`apps/worker` は Connect 常駐、`apps/web` は `inngest.send()`
  投入のみ。受入基準→採用プリミティブ対応表、リスク/軽減、撤退基準（Temporal 再評価トリガ）、11.2 への写像を明記。

### 設計判断（Why）

- **採用理由（優先順）**: (1) HITL 中断/再開が最短（`waitForEvent`）、(2) event 駆動で web↔worker 分離がタダ +
  11.2 Zod イベント union と同型、(3) 運用が要件に比例（既存 Postgres 流用 + 単一バイナリ + Connect）、
  (4) TS-first / 薄いラップ（ADR-2）、(5) 再起動跨ぎ完走を構造的充足。
- **Temporal 却下**: 耐久保証の強度・スケール実績は上だが、承認記述量・determinism/patching・multi-service 運用が
  VAZ 要件規模に不釣り合い（過剰設計回避 = ADR-2「車輪の再発明を避ける」の裏返し）。強い理由が出た時のみ再評価。
- **ロックイン軽減**: 11.2 の `workflows.ts` を **エンジン非依存 Zod 契約**として定義（Inngest API を import しない
  = schemas leaf 規律）。Temporal 差し替え時も契約不変。
- **honest scope**: 8.1 FLAG（Docker/外部到達不可）につき running PoC は不可。現行公式 docs + SDK ソース +
  `research.md` を根拠にした実装マッピング比較として実施（根拠は doc §12 に列挙）。実 PoC 実測は 8.1 解消後の
  Task 12〜14 実装（R3.7/3.8 E2E）で兼ねる。Task 11.1 要求（「実装比較 + 確定結論を記録」）は充足。

### 検証エビデンス（Verification Gate）

- **要件充足**: R3.2（+ 3.4/3.5/3.6/3.7/3.8）を 4 軸比較 + 受入基準→プリミティブ対応表で写像し、単一エンジンを確定。
  ADR-2 / Q2 を解消。
- **回帰ゲート（全緑・doc-only なので非回帰が期待どおり）**:
  - `mise run lint:model-ids` ✅（doc は `apps/**`・`packages/**` 外＝gate 走査対象外、直書きなし）。
  - `mise run lint` = Checked **69 files** / No fixes applied（変化なし）。
  - `mise run typecheck` = apps/web + packages/agents **Done**（doc は非コンパイル面、影響なし）。
  - `mise run test:run` = **15 files / 93 passed**（Task 10R baseline と同一、回帰なし）。

### 学び / Act 申し送り

- **[Task 11.1 完了]** Phase 3 の耐久エンジンを **Inngest** に確定（ADR-2 / Q2 解消）。以降のワーカー/ワークフロー/
  HITL/SSE 実装は Inngest プリミティブ（`createFunction`/`step.run`/`step.waitForEvent`/`Realtime`/Connect）を前提。
- **[申し送り → 11.2]** `packages/schemas/src/workflows.ts` は **エンジン非依存**で定義（Inngest を import しない）。
  supervisor→specialist step I/O Zod + `JobEvent` 判別共用体（step-start/tool-call/token/completion/error）。
  Inngest 側は `EventSchemas.fromZod(...)` で後段（12.x/13.x）に型注入する想定。
- **[残 FLAG 継続]** 8.1（Docker image-pull / 外部到達不可）が未解消のため、R3.7（再起動跨ぎ完走）/ R3.8（翌日承認→
  再開 E2E）の実測は本タスク範囲外 → Task 12〜14 実装 + 8.1 解消環境で実施。
- **次**: Task 11.2（`packages/schemas/src/workflows.ts` — step I/O Zod + `JobEvent` union、TDD RED-GREEN 該当）。

---

## Task 11.2 — ワークフロー契約（`workflows.ts`: step I/O + `JobEvent` union, Phase 3, 2026-07-06）

### Plan（対象・意図）

- **目的**: supervisor→specialist の型付きハンドオフ（R3.3）と、job→SSE→browser の進捗イベント判別共用体（R3.6）を
  `packages/schemas/src/workflows.ts` に Zod で固定。free-form agent chat ではなく **fixed typed steps** を契約化。
- **Boundary**: `packages/schemas/src/workflows.ts`（+ RED テスト `packages/schemas/tests/workflows.spec.ts`）。
  `_Requirements:_` 3.3, 3.6。**TDD RED-GREEN 該当**（`src/` Zod ロジック）。
- **制約（11.1 申し送り）**: **エンジン非依存**（Inngest を import しない = schemas leaf 規律）。

### Do（RED → GREEN → REFACTOR）

- **RED**: `workflows.spec.ts`（32 test）を先行作成 → `Cannot find package '@vaz/schemas/workflows'` で赤化を確認。
- **GREEN**: `workflows.ts` 実装:
  - **specialist 契約（R3.3）**: `specialistKindSchema`（`rag-research`/`document-generation`/`data-processing` の
    closed enum）; `specialistInputSchema` / `specialistResultSchema` = **`kind` 判別の discriminatedUnion**（各 specialist の
    入出力を相互排他に固定）。cross-step ハンドオフ artifact として `document-generation.citations` / `rag-research` result の
    `citations` に **`@vaz/schemas/rag#citationSchema` を再利用**（citation 契約を一元化、engine 非依存）。
  - **plan 契約（R3.3）**: `workflowStepSchema`（`stepId: uuid` + `task`）; `supervisorPlanSchema`（`goal` + `steps.min(1)`＝
    「dispatch しない計画は計画でない」）; `workflowStepResultSchema`（`stepId` で result を相関）。
  - **`JobEvent` union（R3.6）**: `type` 判別の discriminatedUnion（step-start / tool-call / token / completion / error）。
    共通 `jobEventBase`＝`jobId: uuid` + `ts: z.iso.datetime()`。`completion` は `stepId`/`result` を optional にし
    「単一 step 完了（result 付き）」と「job 完了」を同一 variant で表現。`jobEventTypeSchema` も別出し（DB enum / 網羅 switch 用）。
- **REFACTOR**: 規約整合済み（JSDoc に要件 ID、camelCase schema + PascalCase type、`z.uuid()`）。`lint:fix` で import 並べ替えの
  決定論整形のみ（logic 不変）。

### 設計判断（Why）

- **`ts` を `z.iso.datetime()`（ISO 文字列）にした理由**: `JobEvent` は worker 生成 → DB 永続 → **SSE で JSON として browser へ**
  往復する。`z.date()` は JSON round-trip で壊れる（browser 側は文字列）。ISO 文字列は wire-safe で `timestamptz` 列に直写像。
  producer は `deps.now().toISOString()`（ADR-3 clock）で刻む。
- **`data-processing.input` / `result` を `z.unknown()`（opaque）にした理由**: 具体ペイロード形状は `operation` が決め、specialist
  （Task 12）で検証する。契約境界で過剰制約すると正当な payload を弾く。kind は literal で固定しつつ payload は開く。
- **citation 契約の再利用**: rag-research → document-generation の証跡ハンドオフを `citationSchema` で型付け。RED テストで
  「malformed citation は input/result 双方で reject」かつ「同一契約が `@vaz/schemas/rag` から export されたもの」を assert。
- **engine 非依存の徹底**: 本モジュールは `zod` と `./rag` のみ import。Inngest 束縛は下流（worker が `EventSchemas.fromZod` で
  型注入、supervisor/SSE が consume）＝エンジン差し替えが契約を触らない（11.1 の撤退基準を機構的に担保）。

### 検証エビデンス（Verification Gate）

- **タスクテスト（RED→GREEN）**: `pnpm exec vitest run --project packages packages/schemas/tests/workflows.spec.ts`
  = **32 passed**（RED 時は `Cannot find package '@vaz/schemas/workflows'`）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **16 files / 125 passed**（15/93 → +1 file / +32 tests、回帰なし）。
  - `mise run typecheck` = packages/rag・packages/agents・apps/web いずれも **Done**（apps/web tsc が `@vaz/schemas` の
    discriminatedUnion / `z.infer` 型を推移的に実型検査）。
  - `mise run lint` = Checked **71 files** / No fixes applied（初版の import 並びは `lint:fix` で決定論整形、logic 不変）。
  - `mise run lint:model-ids` ✅（モデル ID 直書きなし）。

### 学び / Act 申し送り

- **[Task 11 完了]** 11.1（エンジン確定=Inngest）+ 11.2（`workflows.ts` 契約）で Phase 3 の**契約土台**が確立。
- **[申し送り → Task 12（supervisor / approval policy）]** `createSupervisorWorkflow(deps)` は `supervisorPlanSchema` を計画出力、
  各 step を `specialistInputSchema`（`kind` 判別）で分配し `specialistResultSchema` を回収。Inngest `createFunction` の step 群へ
  写像し、`toolApproval` 中断を `step.waitForEvent` に接続（11.1 §9 対応表）。進捗は `jobEventSchema` を Realtime publish。
- **[残 FLAG 継続]** R3.7/R3.8 の実測（再起動跨ぎ・翌日承認 E2E）は 8.1 解消環境 + Task 13/14 実装で実施（本タスクは契約のみ）。
- **次**: Task 12.1（`packages/agents/src/supervisor.ts` — `createSupervisorWorkflow(deps)`）。

---

## Task 12.1 — `createSupervisorWorkflow(deps)`（supervisor 計画→分配, R3.3）

**成果物**: `packages/agents/src/supervisor.ts`（+ `@vaz/agents/index` 再エクスポート）。TDD RED→GREEN。
`dispatch(plan, { jobId })` が `SupervisorPlan` の各 step を `kind` で specialist へ分配し、`SpecialistResult`
を `stepId` で相関回収。rag-research→document-generation の **citation ハンドオフ**、`JobEvent` 判別共用体
（step-start / per-step completion / error / 末尾 job-level completion）の emit を実装。

### 設計判断（Why）

- **エンジン非依存の徹底（ADR-2 / spike §10 反ロックイン）**: durability を `WorkflowStepRunner`
  ポート seam（`run(stepId, fn)`）に抽出。default は in-process 直実行、Task 13 の `apps/worker` で
  Inngest `step.run` がラップ（完了 step の memoize=R3.5/3.7）。本モジュールは Inngest を import しない
  ＝エンジン差し替えが supervisor を触らない（11.2 契約と同じ leaf 規律を agents 側でも維持）。
- **specialist を registry seam 化**: `options.specialists` で任意 override。default は
  rag-research=RAG capability 実結線（`searchDocuments` をプログラム実行、決定的・LLM 不要）、
  document-generation=`model` seam（`generateText` + 遅延 `resolveModel()`、構築時に provider env を触らない）、
  data-processing=`operation` が app 定義のため未登録時は `SpecialistUnavailableError` を throw（過剰実装回避）。
- **citation ハンドオフの機構**: rag-research 結果の citations を蓄積し、以降の document-generation step が
  自前 citations を持たない場合のみ注入（自前がある step は上書きしない）。契約(11.2)の証跡ハンドオフを実体化。
- **ts は `deps.now().toISOString()`（ADR-3）**: `new Date()` 不使用。テストは固定 clock で全 event の ts を決定的検証。
- **失敗時**: `error` event を emit → 再 throw（リトライ/再開は耐久エンジンの責務、supervisor は失敗を露出のみ）。
  失敗時は job-level completion を出さない（テストで assert）。
- **tool.execute の options**: 検索ツールを model ループ外から呼ぶため合成の `ToolExecutionOptions`
  （`context: {}` 等、ツールは無視）を渡す。`{ query, topK }` のみが意味を持つ。

### 検証エビデンス（Verification Gate）

- **タスクテスト（RED→GREEN）**: `pnpm exec vitest run --project packages packages/agents/tests/supervisor.spec.ts`
  = **10 passed**（RED 時は `Cannot find module '../src/supervisor'`）。network / LLM / engine すべて未接続。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **17 files / 135 passed**（16/125 → +1 file / +10 tests、回帰なし）。
  - `mise run typecheck` = 全 package + `apps/web` tsc **Done**（`erasableSyntaxOnly` 対応で parameter property を
    明示フィールド化、`ToolExecutionOptions.context` 必須を充足）。
  - `mise run lint` = Checked **73 files** / No fixes applied。
  - `mise run lint:model-ids` ✅（モデル ID 直書きなし＝ `resolveModel()` 経由）。

### 学び / Act 申し送り

- **[Task 12.1 完了]** supervisor の **典型分配コア**が確立。R3.3（型付き workflow step 合成）を dispatch エンジン
  ＋ typed registry ＋ 3 specialist スロット ＋ citation ハンドオフ ＋ JobEvent emit で充足。
- **[申し送り → Task 12.2]** `approval-policy.ts` の `toolApproval`（破壊的ツールで中断）を実装し、`WorkflowStepRunner`
  境界で `step.waitForEvent` へ接続する余地を残した（中断は step 実行の外側で表現）。
- **[申し送り → Task 13.x]** `WorkflowStepRunner` を Inngest `step.run` でラップ、`JobEventSink` を Realtime publish に結線、
  data-processing specialist を app 実装で登録。document-generation の R5.2 本格ハードニング（未信頼コンテキスト隔離）は Phase 5。
- **次**: Task 12.2（`packages/agents/src/approval-policy.ts` — `toolApproval` ポリシー）。

---

## Task 12.2 — `createToolApprovalPolicy(options)`（toolApproval ポリシー, R3.4/5.3）

**成果物**: `packages/agents/src/approval-policy.ts`（+ `@vaz/agents/index` 再エクスポート）。TDD RED→GREEN。
AI SDK v7 の `toolApproval` コールバック互換の関数を返す。破壊的ツール呼び出しに `'user-approval'`
（＝承認要求 emit → 実行中断。Inngest では `step.waitForEvent` へ Task 13/14 で接続し suspend/resume 化）、
それ以外に `'not-applicable'`（通常実行）を返す。

### 設計判断（Why）

- **責務分割（plan）**: tool 側が `needsApproval` で「破壊性を宣言」、agents 側（本ポリシー）が
  `'user-approval'` を「判定」＝中断。判定を tool でなく agent に置くことで Phase 5 の R5.3 escalation
  （外部読取駆動時に HITL 強制、lethal trifecta / Rule of Two = Task 19.2）を `isDestructive` フックで拡張可能に。
- **`needsApproval` deprecated への整合**: AI SDK は tool-level `needsApproval` を deprecate し `toolApproval`
  （call-level）へ移行済み。VAZ は `needsApproval` を **破壊性マーカー**として保持（R3.4 の文言を尊重）、
  enforcement は本ポリシー＝現行機構で行う。→ deprecation を「無視」ではなく「機構分離の根拠」として活用。
- **破壊性判定は加算的（safe-by-union）**: ①`isDestructive` フック ②`destructiveTools` 名集合
  ③tool の `needsApproval`（`true` or 述語関数を `(input,{toolCallId,messages,context})` で評価）。
  いずれか true で `'user-approval'`。`isDestructive` が false を返しても `needsApproval` 宣言は抑制されない
  （＝ポリシーが宣言済み破壊ツールを無承認実行させることは構造的に不可能）。
- **`ApprovalToolCall` を `TypedToolCall` の構造的部分集合に**: SDK が渡す richer object を受けられ、
  `streamText({ toolApproval })` の generic approval function へ代入可能（関数引数の反変で成立）。かつテストで
  最小リテラルで tool call を構築でき、`type: "tool-call"` 等の内部フィールド不要。
- **未知ツールの既定**: 宣言・設定にマッチしないツールは `'not-applicable'`（過剰中断の回避）。
  安全側に倒したい場合は `destructiveTools` / `isDestructive` で明示（19.x で既定強化余地）。

### 検証エビデンス（Verification Gate）

- **タスクテスト（RED→GREEN）**: `pnpm exec vitest run --project packages packages/agents/tests/approval-policy.spec.ts`
  = **7 passed**（RED 時は `Cannot find module '../src/approval-policy'`）。pure / network-free。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **18 files / 142 passed**（17/135 → +1 file / +7 tests、回帰なし）。
  - `mise run typecheck` = 全 package + `apps/web` tsc **Done**。
  - `mise run lint` = Checked **75 files** / No fixes applied（import 並びは `lint:fix` で決定論整形）。
  - `mise run lint:model-ids` ✅。

### 学び / Act 申し送り

- **[Task 12.2 完了]** HITL 判定の単一ポリシー点が確立。`'user-approval'` を返す関数を supervisor/worker が
  step 境界で消費し、engine の中断へ写像する（12.1 の `WorkflowStepRunner` 外側で `step.waitForEvent`）。
- **[申し送り → Task 12.3]** `packages/tools/src/email.ts` を `tool({ ..., needsApproval: true })` で実装すれば、
  本ポリシーが自動的に `'user-approval'` を返す（宣言 → 判定の結線が成立）。
- **[申し送り → Task 13/14]** `POST /api/jobs/:id/approve` の承認イベント → 中断中 step の resume シグナル、
  承認 UI（approve/reject/edit args）。`streamText`/step 実行に `toolApproval: createToolApprovalPolicy(...)` を注入。
- **[申し送り → Task 19.2/19.3]** `isDestructive` フックで RAG 駆動ターンの破壊ツール HITL 強制（R5.3）、
  allowlist（R5.4）は tools 側。ポリシーの `'denied'` 返却（無効化）拡張余地も本モジュールに存置。
- **次**: Task 12.3（`packages/tools/src/email.ts` — 破壊的ツール実装、承認フロー実証）。

---

## Task 12.3 — `createEmailCapability(deps)`（代表的破壊的ツール, R3.4）

**成果物**: `packages/tools/src/email.ts`（+ `@vaz/tools/index` 再エクスポート）。TDD RED→GREEN。
`sendEmail = tool({ description, inputSchema, needsApproval: true, execute })`。外部送信という代表的破壊ツールで、
承認フロー（12.2 policy 中断 → 14.x 承認 UI → 再開）を実証可能にする。

### 設計判断（Why）

- **宣言→判定→中断の結線実証**: `needsApproval: true` が 12.2 `createToolApprovalPolicy` の読む破壊性マーカー。
  これ一つで policy が `'user-approval'` を返す＝ HITL 中断が成立（email.spec で `sendEmail.needsApproval === true` を固定）。
  `needsApproval` は AI SDK で deprecated だが、VAZ は「宣言 = tools / enforcement = agents」の分離で意図的に marker として使用。
- **責務境界の遵守**: tools は「ツール定義・入力スキーマ・deps closure・承認宣言」を owns。判定 policy（agents）と
  宛先 allowlist（R5.4 = Task 19.3）は本タスク対象外。過剰実装せず 12.3 の範囲に限定。
- **ADR-3 deps closure**: `sentAt` は `deps.now()`（`new Date()` 不使用）で固定時刻テスト可能。配信は `EmailTransport` seam。
  既定はネットワークなしスタブ（Phase 3 に実メールサーバなし）で `messageId` を clock 由来（`email-<ms>`）＝決定的に。
  実 SMTP/API transport は seam 差し替えで後付け（ツール本体不変）。
- **R4.7 privacy contract 遵守**: `execute` は info で `messageId` のみログ。`subject`/`body`（生の tool 入力 = PII 懸念）は
  info で非記録（`deps.ts` の PRIVACY CONTRACT に整合）。テストで `body`/`subject` キー不在を assert。
- **入力検証**: `z.email()`（Zod v4 組込）で宛先を検証、subject/body は `min(1)`。schema を export し tool と共有。

### 検証エビデンス（Verification Gate）

- **タスクテスト（RED→GREEN）**: `pnpm exec vitest run --project packages packages/tools/tests/email.spec.ts`
  = **7 passed**（RED 時は `Cannot find module '../src/email'`）。network-free（transport seam + pinned clock）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **19 files / 149 passed**（18/142 → +1 file / +7 tests、回帰なし）。
  - `mise run typecheck` = 全 package + `apps/web` tsc **Done**。
  - `mise run lint` = Checked **77 files** / No fixes applied（import 並びは `lint:fix` で決定論整形）。
  - `mise run lint:model-ids` ✅。

### 学び / Act 申し送り

- **[セクション 12 完了]** 12.1（supervisor 分配）+ 12.2（toolApproval policy）+ 12.3（破壊的 email 宣言）で
  **型付き多エージェント合成 + HITL 承認の宣言/判定基盤**が揃った。宣言(email)→判定(policy)→中断('user-approval')が結線済み。
- **[申し送り → Task 13/14]** worker が `createEmailCapability(deps)` を登録し、step 実行時に
  `toolApproval: createToolApprovalPolicy(...)` を注入 → `'user-approval'` を engine の `step.waitForEvent` へ写像。
  `POST /api/jobs/:id/approve`（承認イベント）→ 再開、承認 UI（approve/reject/edit args）は 14.x。実 transport 差し替えもここ。
- **[申し送り → Task 19.3]** 外部送信ツールの宛先 allowlist 強制（R5.4）を `packages/tools/src/allowlist.ts` に。email はその適用先。
- **次**: Task 13.1（`apps/worker/package.json` — `@vaz/worker` 定義）。

---

## Task 13.1 — `apps/worker/package.json`（`@vaz/worker` 定義, Node 24 常駐, R3.1）

### Plan（対象・意図）

- **境界**: `apps/worker/package.json`（Create、単一編集境界 ―― worker manifest は 13.1 のみが編集境界）。
  **Depends**: 12.1（完了）。**Requirements**: 3.1。
- **意図（R3.1）**: 長時間実行ワーカー `@vaz/worker` を第 2 の app（`apps/web` と並ぶ）として workspace member 化。
  耐久ワークフロー実行（13.2〜）・進捗イベント永続化（13.3）・worker 経路 audit sink（13.4）・
  コンテナ化（13.5）の home を確立し、dep グラフ末端（… → agents/rag → **worker**）へ組み込む。

### Do（実装）

- **app 型 manifest**（source-only package ではなく `apps/web` 系）: `private: true` / `version: 1.0.0`。
  ただし常駐 Node プロセスが `@vaz/*`（全て `type: module`）を `node src/main.ts` で ESM import するため
  **`type: module` を明示**（apps/web は Next が解決するため未指定 ―― worker は生 Node なので必要）。
- **`engines.node: ">=24"`**: 「Node 24 常駐」（R3.1 / mise `node=24`）を manifest に明文化。source-only
  package には無い制約だが常駐プロセスの実行時前提を記録（タスク文言の直接反映）。
- **dependencies（タスク明示の 2 件のみ）**: `@vaz/agents`(workspace:\*) + `@vaz/rag`(workspace:\*)。
  両者は config/schemas/tools を推移的に含むため 2 件で充足。**新規外部依存ゼロ**（lockfile churn なし）。
- **scripts 前方宣言**（8.2 の `ingest` 前例に倣う ―― 13.2 境界は `src/main.ts` のみで package.json 再編集不可）:
  `start: "node src/main.ts"`（Node 24 native TS、rag `node bin/ingest.ts` と同型）+
  `typecheck`（`if [ -d src ]` ガード ―― `src/` 実装前は skip marker、apps/web と同型で凍結 mise
  `pnpm -r run typecheck` 不変条件を緑維持）。
- **[deferred → 13.2/13.5]** 耐久エンジン（Inngest, Task 11 spike）依存は本 manifest に**未追加**。タスク文言が
  deps を agents/rag に限定、かつ新規外部依存は allowBuilds 監査 + registry 到達性が前提（8.6 前例）。
  engine dep はエンジン結線（13.2）/ compose（13.5）で境界拡張して追加する。

### TDD 判断

- `src/` ユニットロジックではなくパッケージ定義（package.json）のため Red-Green-Refactor（失敗テスト先行）は
  **非適用**（tasks.md L14 テスト規約 / 3.1・8.2 と同一）。代替: member 登録 RED→GREEN + 検証ゲート。

### 検証エビデンス（Verification Gate）

- **RED→GREEN（member 登録）**: `pnpm --filter @vaz/worker run typecheck`
  = RED `No projects matched the filters`（未登録）→ `pnpm install`（**all 8 workspace projects**, 7→8）
  → GREEN skip marker 実行。`pnpm ls --filter @vaz/worker --depth 0` = `@vaz/agents@link:` + `@vaz/rag@link:`。
- **install churn ゼロ**: `pnpm install` = `downloaded 0, added 0` / `Lockfile passes supply-chain policies`、
  `pnpm install --frozen-lockfile` = `Already up to date`（workspace:\* のみ＝新規 install なし）。
- **回帰ゲート（全緑）**:
  - `mise run lint` = Checked **78 files** / No fixes applied（77→78）。
  - `mise run typecheck` = 全 package + `apps/web` + `apps/worker`(skip) tsc **Done**（exit 0）。
  - `mise run test:run` = **19 files / 149 passed**（回帰なし）。

### 学び / Act 申し送り

- **Task 13.1 完了**: `@vaz/worker` を新規外部依存ゼロで第 2 app として member 化。deps(agents/rag) + start/typecheck
  script を前方宣言。dep グラフ末端に worker を接続。
- **[申し送り → 13.2]** `src/main.ts` にエンジンワーカーエントリ + step 実行。耐久エンジン（Inngest）依存を
  package.json へ**境界拡張追加**（3.4/8.3 の manifest 境界拡張前例）＋ `allowBuilds` 監査（install script 有無を確認）＋
  npm registry 到達性を事前確認（8.1/8.6 環境注意）。span に `jobId`/`userId`/agent 名を付与。
- **[申し送り → 13.5]** `Dockerfile`（`pnpm deploy` で worker を単独デプロイ ―― `type: module` + `engines.node>=24`
  前提）+ `docker-compose.yml` に worker/engine/redis サービス追加。
- **次**: Task 13.2（`apps/worker/src/main.ts` — エンジンワーカーエントリ + step 実行）。

---

## Task 13.2 — `apps/worker/src/main.ts`（エンジンワーカーエントリ + step 実行, R3.1/3.2/4.2）

### Plan（対象・意図）

- **境界**: `apps/worker/src/main.ts`（Create）。**Depends**: 13.1 / 11.2（workflows 契約）/ 9.4（RAG capability）。
  **Requirements**: 3.1（worker が agents/rag を import）, 3.2（耐久エンジン駆動 + web↔worker 分離）, 4.2（span に jobId/userId/agent名）。
- **意図**: 長時間実行ワーカーのエントリを実装。①耐久エンジンの job function 登録 + step 実行、
  ②ジョブ投入（web）と実行（worker）の分離、③ジョブ/ステップ span への jobId/userId/agent名 付与。

### Do（実装）— エンジン非依存の合成（ADR-2 / spike §9・§10）

- **エンジン(Inngest)を import しない**: spike で Inngest 確定済みだが、supervisor と同様に本ファイルも
  エンジン SDK を import しない。耐久性は既存 `WorkflowStepRunner` ポート（Inngest `step.run` が構造的に充足）で、
  エンジン本体は `DurableEngine` seam（Inngest `createFunction`/`send` と同形）で注入する。
  具体 `new Inngest(...)` クライアント・`inngest` パッケージ・Connect 起動は **コンテナ端（Task 13.5）** に委譲
  （8.1 FLAG により本環境でエンジンを起動できず、実耐久性=再起動跨ぎ/翌日承認は Task 15 の耐久 E2E で実証）。
  → エンジン差し替えが本ファイルに波及しない（ADR-2 anti-lock-in を worker まで貫徹）。
- **runJob(deps, request, options)**: JobRequest を検証（`supervisorPlanSchema.parse` で plan 検証）→ `worker.job` span
  （attr: jobId/userId）を開く → `createSupervisorWorkflow(deps, {step, emit})` に dispatch。step 失敗時は span を
  errored + recordException し **rethrow**（耐久エンジンが retry/resume を所有 ―― 握り潰さない）。
- **span 付与（R4.2）は emit フック経由**: `step-start` イベントのみが specialist `kind`（＝agent名）を持つため、
  emit を wrap し step-start で `worker.step` 子 span（attr: jobId/userId/stepId/**agent=kind**）を開き、
  completion/error で閉じる。全イベントは caller の emit へそのまま転送（instrumentation は加算的）。
  OTel API 依存を避けるため tracer は構造 seam（`WorkerTracer`/`WorkerSpan`, 既定 noop）＝ Task 13.5 で実 OTel を注入。
- **web↔worker 分離（R3.2）**: `submitJob(engine, request)` = `engine.send({name:"job/requested", data})`（web 側投入）、
  `registerWorker(engine, deps)` = `engine.createFunction(JOB_FUNCTION_CONFIG, {event:"job/requested"}, createJobHandler)`
  （worker 側実行）。投入は実行にブロックしない。`JOB_REQUESTED_EVENT`/`JOB_FUNCTION_CONFIG` を export（13.5/14.1 が消費）。
- **buildWorkerDeps（合成ルート, ADR-3）**: 実 wall clock（`now: () => new Date()` ―― 合成ルートのみ許容、
  route.ts と同型）+ R4.7 遵守の console logger。db/audit（Task 13.4 の DB sink）は注入 seam。

### 境界拡張（各々に前例・正当化を明記）

- `apps/worker/package.json`: `@vaz/schemas`（main.ts が直接 import ―― 宣言責務、apps/web も同様）+ devDep
  `@types/node`（worker は純 Node プロセス、`process` 等の型解決）。いずれも **新規外部依存ゼロ**（workspace/lockfile 既存）。
  13.1 申し送りで 13.2 の package.json 拡張を予告済み（3.4/8.3 の manifest 境界拡張前例）。
- `apps/worker/tsconfig.json`（新規）+ `apps/worker/vitest.config.ts`（新規）+ root `vitest.config.ts`（worker project 登録）:
  新規 app の typecheck + TDD に必須の scaffold。**apps/web と同型**（per-app tsconfig + vitest project を root aggregator へ登録）。
  tests 規約（L14）は unit テストの scaffold 依存を許容。tsconfig は Node 専用（DOM/jsx/next 非搭載, `types:["node"]`,
  `include:["src"]` ―― apps/web と同じく tests は gate tsc 対象外＝Vitest globals を持ち込まない）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project worker apps/worker/tests/main.spec.ts` → `Cannot find module '../src/main'`
  → GREEN = **12 passed**（step 実行/span 属性/エラー時 rethrow/emit 転送/anonymous userId/submitJob/registerWorker/
  createJobHandler/buildWorkerDeps/多段順序）。network/engine/LLM/DB 非依存（injected seams のみ）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **20 files / 161 passed**（19/149 → +1 file / +12、回帰なし）。
  - `mise run typecheck` = 全 package + apps/web + **apps/worker** tsc **Done**（exit 0）。
  - `mise run lint` = Checked **82 files** / No fixes applied。`mise run lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（churn ゼロ ―― workspace dep のみ）。

### 学び / Act 申し送り

- **Task 13.2 完了**: engine-agnostic な worker エントリ（runJob / registerWorker / submitJob / createJobHandler /
  buildWorkerDeps）を **inngest 依存ゼロ**で実装。耐久性=step ポート、エンジン=`DurableEngine` seam、可観測性=tracer seam。
- **[申し送り → 13.3]** `src/events.ts` に進捗イベント永続化（DB/Redis pub/sub）。runJob の `options.emit` に接続する
  `JobEventSink` 実装を供給（DB 書込 + Redis publish）。JobEvent 判別共用体（11.2）を消費。
- **[申し送り → 13.4]** `src/audit.ts` に worker 経路の `deps.audit` DB sink。`buildWorkerDeps({audit})` へ注入（発火点は @vaz/agents）。
- **[申し送り → 13.5]** `Dockerfile` + `docker-compose.yml`（worker/engine/redis）。**ここで `inngest` を package.json へ追加**し、
  `const engine = new Inngest({id:"vaz-worker", schemas: EventSchemas.fromZod(...)})` を構築 → `registerWorker(engine, buildWorkerDeps({db,audit}))`
  → Connect(WS :8289) で常駐（spike §7）。`DurableEngine`/`JobFunctionContext` は Inngest API と同形なので配線は薄い。
  `allowBuilds` に inngest（+ script 持ちの推移的依存）を監査追記、npm registry 到達性を事前確認（8.6 前例）。
- **[申し送り → 13.6]** チェックポイント中断→再開・再起動跨ぎ完走は `step.run` memoize + `step.waitForEvent` で成立（spike §3-4）。
- **[申し送り → 14.1]** `POST /api/jobs` は `submitJob(engine, {jobId,userId,plan})` を呼ぶ。job 投入 schema は
  @vaz/schemas へ切り出す余地あり（現状 JobRequest は worker ローカル契約）。
- **次**: Task 13.3（`apps/worker/src/events.ts` — 進捗イベント永続化）。

---

## Task 13.3 — `apps/worker/src/events.ts`（進捗イベント永続化, R3.6）

### Plan（対象・意図）

- **境界**: `apps/worker/src/events.ts`（Create）。**Depends**: 13.1 / 11.2（JobEvent 判別共用体）。**Requirements**: 3.6。
- **意図**: supervisor が emit する JobEvent（step-start/tool-call/token/completion/error）を worker 側で
  ①耐久ストア（DB）へ append、②pub/sub（Redis）へ publish し、SSE Route（14.2）+ useJobStream（14.4）が
  ブラウザへストリームできる土台を供給。runJob(13.2) の `options.emit` に接続する `JobEventSink` 実装。

### Do（実装）

- **`createJobEventSink(deps, {store?, publisher?}): JobEventSink`**: 各 JobEvent を `jobEventSchema`(11.2) で
  検証 → store.append（履歴, 遅延購読者の replay 用）→ publisher.publish（live fan-out）。**append を先**に実行
  （途中参加の購読者が prior events を replay してから live tail を受ける順序保証）。
- **注入ポート（ADR-2/ADR-3, main.ts と同型）**: `JobEventStore.append` / `JobEventPublisher.publish` は seam。
  `pg`/Drizzle も Redis SDK も import しない。実 Postgres store / Redis publisher はコンテナ端(13.5)で注入、
  テストは fake 注入で infra 不要。R3.6 の「DB **or** Redis」に従い両者 optional（両方/片方/なし可、なし=安全 no-op）。
- **fail-soft（観測プレーン）**: store/publish の失敗は deps.logger.error でログして握り潰す（互いに独立）。
  返す sink は**決して reject しない** ―― supervisor は emit を await するため、観測エラーでジョブを落とさない
  （ジョブの resume 状態はエンジンが所有, 13.2/13.6）。リポジトリの fail-soft telemetry 方針に整合。
- **R4.7 privacy**: 失敗ログは `correlation()` で jobId/type/stepId のみ（`result`/`args`/token `delta` 等の
  ユーザ内容・PII は非記録）。malformed event も防御的に読み取り診断可能なログを出す。
- **境界検証**: 不正イベント（11.2 契約違反）は safeParse で drop（append/publish せず warn ログ）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project worker apps/worker/tests/events.spec.ts` → `Cannot find module '../src/events'`
  → GREEN = **9 passed**（persist+publish/append-before-publish/全 union variant/store・publisher 単独/なし no-op/
  store 失敗 fail-soft/publisher 失敗 fail-soft/R4.7 payload 非記録/malformed drop）。DB/Redis 非依存（injected fakes）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **21 files / 170 passed**（20/161 → +1 file / +9、回帰なし）。worker project = 21 tests。
  - `mise run typecheck` = exit 0（apps/worker 含む全 Done）。
  - `mise run lint` = No fixes applied（`lint:fix` で import 1 行化＋関数整形の決定論フォーマットのみ適用後）。`lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（**新規依存ゼロ** ―― events.ts は既存 workspace dep のみ）。

### 学び / Act 申し送り

- **Task 13.3 完了**: JobEvent 永続化 sink を injected store/publisher ポートで実装。fail-soft + R4.7 遵守。
- **[申し送り → 13.5]** 実装注入: Postgres `JobEventStore`（Drizzle。`job_event` テーブル DDL が要 ―― workflows.ts が
  参照する `Job`/`JobEvent` テーブルは未定義。schema は @vaz/rag/db パターンで別途 migration 必要、または schemas 側で契約化）+
  Redis `JobEventPublisher`。`registerWorker(engine, deps, { emit: createJobEventSink(deps, {store, publisher}) })` で結線。
- **[申し送り → 14.2]** SSE Route は publisher の購読側（subscribe）+ store の replay 読み出し（history）を消費。
  events.ts は producer（append/publish）のみを所有 ―― subscribe/read は SSE 側の責務。
- **[注意]** `Job`/`JobEvent` の Drizzle テーブルはまだ存在しない（workflows.ts コメントの参照は先行宣言）。13.5 の
  store 実装前に schema/migration の所在を確定すること（@vaz/rag/db/schema 拡張 or 新規）。
- **次**: Task 13.4（`apps/worker/src/audit.ts` — worker 経路の deps.audit DB sink）。

---

## Task 13.4 — `apps/worker/src/audit.ts`（worker 経路 deps.audit DB sink, R5.5）

### Plan（対象・意図）

- **境界**: `apps/worker/src/audit.ts`（Create）。**Depends**: 13.1。**Requirements**: 5.5。
- **意図（R5.5）**: 全ツール実行（who=userId / which job=jobId / with what args）を DB 監査ログへ記録する
  `AuditSink` の **worker 経路実装**を供給。発火点は `@vaz/agents` lifecycle audit-hook（Task 20.2）；web 経路は
  同一契約で別実装（Task 20 の `apps/web/src/lib/audit.ts`）。本モジュールは**永続化のみ**を所有。

### Do（実装）

- **`createAuditSink(deps, {store}): AuditSink`**: `record(entry)` が `AuditLogStore.insert(entry)` で
  AuditEntry（userId/jobId/tool/args/ts）を DB へ append。
- **注入ポート（ADR-2/ADR-3, events.ts と同型）**: `AuditLogStore.insert` は seam ―― `pg`/Drizzle 非 import。
  実 Postgres store（`audit_log` テーブル insert）はコンテナ端(13.5)で注入、`buildWorkerDeps({audit})` 経由で結線。
  `store` は **必須**（store 無し sink = 無音で記録ゼロ＝コンプラ穴。Phase 1 の no-op 監査は `deps.audit` 省略で表現）。
- **fail-loud（events.ts の fail-soft と意図的に対比）**: 観測イベントは blip 許容だが、監査は R5.5 の
  「record EVERY tool execution」義務 ―― store 失敗はログの上 **re-throw**（握り潰さない）。fail-open/closed の
  **ポリシーは発火点(20.2)の責務**（ツール破壊性 R5.3 で判断可）。sink は結果を忠実に surface するのみ。
- **R4.7 privacy**: args は DB へ永続化（R5.5 の目的そのもの）が、**ログには出さない** ―― 失敗ログは
  userId/jobId/tool の相関のみ（raw args 非記録）。テストで `SENSITIVE-ARG`/宛先がログに出ないことを assert。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project worker apps/worker/tests/audit.spec.ts` → `Cannot find module '../src/audit'`
  → GREEN = **6 passed**（who/job/tool/args/ts 永続化・jobId null・userId null・順序・store 失敗 re-throw+ログ・
  R4.7 失敗ログに args 非混入かつ相関 id は present）。DB 非依存（injected fake store）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **176 passed**（170 → +6、回帰なし。worker project = 27 tests）。
  - `mise run typecheck` = exit 0（apps/worker 含む全 Done）。
  - `mise run lint` = No fixes applied（`lint:fix` の決定論整形後）。`lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（**新規依存ゼロ** ―― 型のみ import）。

### 学び / Act 申し送り

- **Task 13.4 完了**: worker 監査 DB sink を injected `AuditLogStore` ポートで実装。fail-loud + R4.7 遵守。
- **[申し送り → 13.5]** 実装注入: Postgres `AuditLogStore`（Drizzle。`audit_log` テーブル DDL 要 ―― `job_event`(13.3)と
  同様に未定義。schema/migration の所在を確定）。`buildWorkerDeps({ db, audit: createAuditSink(deps, {store}) })` で結線。
- **[申し送り → 20.1/20.2]** 20.1 で `AuditEntrySchema`(Zod) 確定 ―― 確定後は sink 側 insert 前の contract 検証を検討可
  （現状は plain type 契約、deps.ts の 20.1 委譲に従い Zod 未導入）。20.2 audit-hook が全ツール呼を `deps.audit.record` へ
  発火（web/worker 共通発火点）。fail-open/closed ポリシーは 20.2 が所有（本 sink は re-throw で結果を surface）。
- **[申し送り → 13.5 統合]** `Job`/`JobEvent`/`audit_log` の 3 テーブルが未定義。13.5 の store 実装前に Drizzle schema を
  @vaz/rag/db 拡張 or 新規で用意（migration 含む）。
- **次**: Task 13.5（`apps/worker/Dockerfile` + `docker-compose.yml` ―― worker/engine/redis サービス）。

---

## Task 13.5 — `apps/worker/Dockerfile` + `docker-compose.yml`（worker/engine/redis, R3.1）

### Plan（対象・意図）

- **境界**: `apps/worker/Dockerfile`（Create）, `docker-compose.yml`（Modify）。**Depends**: 13.2。**Requirements**: 3.1。
- **意図（R3.1）**: worker をコンテナ化（`pnpm deploy` で自己完結デプロイ）し、compose に耐久エンジン(Inngest)+
  Redis+worker サービスを追加。web(投入)↔worker(実行) の実行基盤を dev で立ち上げ可能にする。

### Do（実装）

- **Dockerfile（multi-stage / `pnpm deploy`）**: build 段で `pnpm install --frozen-lockfile` → `pnpm --filter=@vaz/worker
  deploy --prod /out`（workspace deps 同梱・devDep 除去）。runtime 段は `node:24-slim`・非 root(`node`)・`CMD ["node","src/main.ts"]`
  （source-only TS を Node 24 が type-strip 実行 ―― rag `node bin/ingest.ts` と同機構、compile 不要）。
  `NODE_VERSION`/`PNPM_VERSION`(11.10.0) を ARG 化。worker は engine:8289(Connect) へ **outbound** ―― inbound port なし。
- **docker-compose.yml（+3 services）**: `redis`(redis:7-alpine, pub/sub+Inngest backend, healthcheck redis-cli ping)、
  `engine`(inngest/inngest:**v1.19.3**, `inngest start`, :8288 UI/API + :8289 Connect, INNGEST_EVENT_KEY/SIGNING_KEY/
  POSTGRES_URI/REDIS_URI, depends_on db+redis healthy, healthcheck `inngest alpha doctor healthcheck`)、
  `worker`(build apps/worker/Dockerfile, INNGEST_DEV=0/BASE_URL=http://engine:8288 + DATABASE_URL/REDIS_URL + provider env,
  depends_on db+redis healthy/engine started)。既存 `db`(pgvector) を Inngest の Postgres backend として再利用（dev。
  prod は分離）。`redisdata` volume 追加。env 補間は既存 `${VAR:-default}` 様式に統一、INNGEST_* は dev 既定 + `.env` 上書き。
- **`.dockerignore`（scaffold, 正当化）**: Dockerfile が正しくビルドされるための必須 scaffold（host `node_modules` の
  絶対パス symlink が image を破壊 ―― 除外必須。`.env*`/`.git`/`.next`/coverage 等も除外）。13.2 の scaffold 拡張前例に倣う。

### TDD 判断 / 検証エビデンス（Verification Gate）

- config タスク（Dockerfile/compose/dockerignore）につき Red-Green-Refactor（失敗 src テスト）は**非適用**（3.1/8.2 と同型）。
  代替: `docker compose config` の RED→GREEN + 回帰。
- **RED→GREEN（compose services）**: `docker compose config --services` = RED（`db` のみ）→ GREEN（**db / engine / redis / worker**）。
  `docker compose config` = **VALID**（全補間・スキーマ検証 exit 0）。
- **回帰ゲート（全緑）**: `mise run lint` = **86 files / No fixes**（biome は yml/Dockerfile/.dockerignore 非対象）。
  `mise run typecheck` = exit 0。`mise run test:run` = **176 passed**（13.5 はコード追加なし＝回帰なし）。`lint:model-ids` ✅。
- **[env FLAG]** Docker **daemon 未起動**（CLI のみ）＝ `docker build`/image pull 不可（8.1 FLAG）。Dockerfile は
  `docker compose config`（build context 参照）+ pnpm-deploy/Inngest 自己ホスト reference（spike §7/§9）に基づく authoring で検証。
  実ビルド + 再起動跨ぎ実行は FLAG 解消環境（Task 15 耐久 E2E）で兼ねる。

### 学び / Act 申し送り（既知ギャップ ―― 明示）

- **Task 13.5 完了**: worker コンテナ + engine/redis compose サービスを定義・compose config VALID。ただし**コンテナは現時点で
  end-to-end 稼働しない**（下記ギャップ）。定義としては完成、稼働は後続タスク依存。
- **[ギャップ1 → 要フォロー]** `inngest` npm 依存 + main.ts の**具体 Inngest client bootstrap**（`new Inngest(...)` +
  `registerWorker(engine, buildWorkerDeps({db,audit}), {emit})` + Connect 常駐）が未実装。現 `CMD node src/main.ts` は
  main.ts が export のみ＝即終了する。**どのタスクも inngest 依存追加/bootstrap を明示所有していない**（13.6 境界は main.ts のみで
  package.json 不可）。→ 13.6 で main.ts に bootstrap を、別途 package.json へ inngest 追加（allowBuilds 監査 + registry 到達性）を要調整。
- **[ギャップ2 → 13.6/フォロー]** `job_event`/`audit_log`/`Job` の Drizzle テーブル + events.ts/audit.ts の実 Postgres/Redis
  store 実装が未定義。worker が JobEvent/audit を実永続化するには schema/migration（@vaz/rag/db 拡張 or 新規）+ store 結線が必要。
- **[運用注意]** engine は既存 `db` を共有（dev 簡素化）。prod は Inngest 専用 Postgres/Redis + 実 INNGEST_SIGNING_KEY
  (`openssl rand -hex 32`) へ分離。engine image tag(v1.19.3) は healthcheck(`doctor`)可用性根拠で選択 ―― deploy 時に最新安定へ要確認。
- **次**: Task 13.6（`apps/worker/src/main.ts` ―― チェックポイント中断→再開・worker 再起動跨ぎ完走。上記ギャップ1 の bootstrap もここで検討）。

---

## Task 13.6 — チェックポイント中断→再開 + 再起動跨ぎ完走（`apps/worker/src/main.ts`, R3.5/3.7）

### Plan（対象・意図）

- **境界**: `apps/worker/src/main.ts`（Modify）。**Depends**: 13.2。**Requirements**: 3.5（承認イベントでチェックポイント再開）,
  3.7（10 分超ジョブが worker 再起動を跨いで完走）。
- **意図**: 耐久性本体はエンジン（Inngest `step.run` memoize + `step.waitForEvent` suspend）が所有。worker が所有・
  テスト可能なのは**配線** ―― 破壊的ステップ手前で承認待ち中断し、memoize されたチェックポイントから再開する
  approval-aware / checkpoint 委譲の step runner。実エンジンでの実耐久は Task 15 耐久 E2E で兼ねる（8.1 FLAG）。

### Do（実装 ―― main.ts 拡張、engine-agnostic 維持）

- **`createDurableStepRunner(engineStep, {jobId, requiresApproval?, approvalGate?, approvalTimeout?})`**: 供給された
  engine step port を wrap。`requiresApproval(stepId)` が true のステップは実行前に `approvalGate` を await（R3.4/3.5）。
  **承認 await 自体を `engineStep.run("approval:"+stepId, gate)` 経由**で通す ―― 決定も memoize され、再起動後の
  resume は決定を replay して**再プロンプトしない**（R3.5）。承認後に `engineStep.run(stepId, fn)`（memoize）。
  **fail-closed**: requiresApproval=true かつ gate 未設定は `ApprovalDeniedError("misconfigured")`（無承認実行を拒否）。
- **seams/契約追加**: `ApprovalGate`（Inngest `step.waitForEvent` アダプタ、null=timeout）、`ApprovalDecision`(approved+args)、
  `ApprovalSignal`（承認 UI→engine）、`ApprovalDeniedError`(stepId+reason: rejected|expired|misconfigured)、
  定数 `APPROVAL_EVENT="job/approval"` / `DEFAULT_APPROVAL_TIMEOUT="7d"`（R3.8 翌日承認）。
- **runJob 配線**: requiresApproval 指定時に engine step（無ければ in-process DIRECT）を `createDurableStepRunner` で
  wrap して supervisor へ注入。未指定時は従来どおり素通し（挙動不変）。→ checkpoint replay（R3.7）は wrap 有無に依らず
  engineStep の memoize に委譲。
- **createJobHandler**: engine ctx の `waitForApproval`（Inngest `step.waitForEvent`）を approvalGate として転送
  （caller override 優先）。JobFunctionContext に `waitForApproval?` を追加。
- **`submitApproval(engine, signal)`**: 承認 UI（Task 14.3）が `APPROVAL_EVENT` を送出 → engine が jobId で suspended
  workflow に match → チェックポイント再開（reject/edit-args を signal に載せる）。`DurableEngine.send` の data を
  `JobRequest | ApprovalSignal` に拡張。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project worker apps/worker/tests/durability.spec.ts` → 新シンボル未実装で 7 failed
  → GREEN = **9 passed**。カバレッジ:
  - **R3.7**: memoizing runner（Inngest server-side checkpoint を模擬）で run1(step1 完了+cache→step2 crash)→
    run2(同一 cache=再起動: step1 は fn 再実行されず replay、step2 成功で完走)。**完了ステップの二重実行なし**を execCount で実証。
  - **R3.5**: flagged step 手前で承認 await → approve で実行 / reject で ApprovalDeniedError かつ specialist 未実行 /
    timeout(null)→expired / fail-closed(gate 無)→denied かつ未実行 / 非 flagged は gate 非呼出。
  - **R3.5+3.7**: 承認 granted は checkpoint 化 → crash 後 re-dispatch で gate 再呼出なし（callsAfterRun1=2 のまま）＝**resume 再プロンプトなし**。
  - submitApproval が APPROVAL_EVENT + signal を送出 / ApprovalDeniedError が stepId+reason を保持。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **185 passed**（176 → +9、worker project = 36 tests、回帰なし）。
  - `mise run typecheck` = exit 0（apps/worker 含む全 Done）。
  - `mise run lint` = No fixes applied（`lint:fix` の決定論整形後）。`lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（**新規依存ゼロ**）。

### 学び / Act 申し送り

- **Task 13.6 完了 → セクション 13（apps/worker）全 6 タスク完了**。worker は engine-agnostic な entry（runJob/registerWorker/
  submitJob/**submitApproval**/createJobHandler/buildWorkerDeps）+ 進捗永続化 sink（events.ts）+ 監査 sink（audit.ts）+
  **checkpoint/承認 resume 配線（createDurableStepRunner）**+ コンテナ/compose（Dockerfile+engine/redis）を備える。
- **[申し送り → 14.x]** 14.1 `POST /api/jobs`→`submitJob`。14.2 SSE は events.ts publisher 購読 + store replay。
  14.3 `POST /api/jobs/:id/approve`→`submitApproval(engine, {jobId, stepId, approved, args})`。14.5 承認 UI は
  ApprovalDeniedError.reason（rejected/expired）で terminal 状態を描画。承認 UI は「どのステップが破壊的か」を
  step-start イベント（kind）+ requiresApproval 述語で判定。
- **[申し送り → Task 15 耐久 E2E]** 実 Inngest で restart-crossing（R3.7）+ 翌日承認 resume（R3.8）を実測。
- **[未解決ギャップ（13.5 記載の再掲・要フォロー）]** ①`inngest` npm 依存 + main.ts の具体 `new Inngest(...)` bootstrap
  （registerWorker + Connect 常駐）が未所有 ―― 現 Dockerfile CMD `node src/main.ts` は export のみで即終了。どのタスクも
  この bootstrap+依存追加を明示所有していない（本 13.6 は R3.5/3.7 の配線に限定、bootstrap 追加は package.json 越境を伴い 13.6 境界外）。
  ②`job_event`/`audit_log`/`Job` の Drizzle テーブル + events.ts/audit.ts の実 Postgres/Redis store 実装が未定義。
  → いずれも Phase 3 を実稼働させる前（または Task 14/15 の実配線時）に別途タスク化が必要。
- **次**: Task 14.1（`apps/web/src/app/api/jobs/route.ts` ―― `POST /api/jobs`）。

---

## Task 13 検証フォロー — ギャップ対応タスク起票（/sdd-validate-impl 2026-07-08）

`/sdd-validate-impl Task13` は **GO** 判定（6/6 完了・185 tests 緑・要件 7/7 トレース・回帰なし）だが、
Phase 3 実稼働前に必要な2つの機能ギャップを検出。ユーザー指示「apply recommended fixes」=**推奨どおり
フォロータスク起票**（実装ブラインドではなく Boundary/Depends/Requirements を定義）。tasks.md に追加:

- **13.7**（schema）: `Job`/`JobEvent`/`AuditLog` Drizzle テーブル。_Boundary_ `packages/rag/src/db/schema.ts`、
  _Depends_ 8.3/11.2、_Req_ 3.6/5.5。（DB home は現状 @vaz/rag のみ＝schema.ts 拡張。専用 @vaz/db 分離は範囲外）
- **13.8**（stores）: events.ts/audit.ts の port への実 store（Postgres append/insert + Redis publish）。
  _Boundary_ `apps/worker/src/{stores,publisher}.ts` + package.json + pnpm-workspace.yaml、_Depends_ 13.3/13.4/13.7、_Req_ 3.6/5.5。
- **13.9**（bootstrap）: `inngest` 依存 + `new Inngest` engine 構築（EventSchemas.fromZod）+ `step.waitForEvent`→ApprovalGate
  写像 + registerWorker + Connect 常駐 + Dockerfile CMD 更新。_Boundary_ `apps/worker/src/{inngest,start}.ts` + package.json +
  pnpm-workspace.yaml + Dockerfile、_Depends_ 13.6/13.8、_Req_ 3.1/3.2/3.5。

section 13 header の _Boundary_/_Depends_ も新規ファイル・依存(11,8)を反映。13.1–13.6 の成果物（seam/port/配線）は
不変 ―― 13.7–13.9 はその上に具体実装を積む（engine-agnostic 設計により main.ts 等コアは非改変で済む想定）。
実行は `/sdd-impl 001-vaz-ai-update 13.7`（→13.8→13.9）。実 DB/engine 検証は 8.1 FLAG 解消環境（Task 15 E2E）。

---

## Task 13.7 — `Job`/`JobEvent`/`AuditLog` Drizzle テーブル（`packages/rag/src/db/schema.ts`, R3.6/5.5）

### Plan（対象・意図）

- **境界**: `packages/rag/src/db/schema.ts`（Modify=拡張）。**Depends**: 8.3, 11.2。**Requirements**: 3.6, 5.5。
- **意図**: 13.8 の実 store（events/audit sink の Postgres 実装）が依存する永続化スキーマを定義。plan.md データモデル
  （Job/JobEvent/AuditLog 行）+ 11.2 JobEvent 契約 + AuditEntry(deps.ts) を DB 化。

### Do（実装）

- **`jobStatusEnum`**（pgEnum "job_status"）= pending/running/**suspended**(HITL 承認待ち R3.5)/completed/failed。
- **`jobEventTypeEnum`**（pgEnum "job_event_type"）= 11.2 `jobEventTypeSchema` と同値（step-start/tool-call/token/completion/error）。
- **`job`**: id(uuid pk)/userId(text,null 可)/status(enum,default pending)/workflow(text)/createdAt(timestamptz,default now)。
- **`jobEvent`**: id/jobId(uuid fk→job **cascade**)/type(enum)/payload(jsonb=variant fields)/ts(timestamptz)。判別共用体を
  type+payload で表現し full `jobEventSchema` を round-trip。
- **`auditLog`**: id/jobId(uuid fk→job **set null**,null 可=同期チャット経路)/userId(text,null 可)/tool(text)/args(jsonb)/ts。
  args は audit の保持対象(R5.5 目的)だが INFO ログには出さない(R4.7)。set null で job 削除後もコンプラ記録が残存。
- **drizzle-zod**: job/jobEvent/auditLog の insert/select schema を単一ソース化（RAG 3 テーブルと同型）。
- **配置注記**: DB infra(drizzle+pg)の home が現状 @vaz/rag のみのため schema.ts を拡張。ドメイン的には workflow/security
  だが専用 `@vaz/db` 分離は Phase 3 範囲外の refactor（コメントに明記）。schema.ts は `@vaz/schemas` を runtime import しない
  （enum はハードコード + テストで drift 検出）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project packages packages/rag/tests/schema.spec.ts` → テーブル/enum 未 export で 8 failed
  → GREEN = **8 passed**。カバレッジ: 3 テーブルの列集合（plan.md 準拠）/ **enum drift 検出**（`jobEventTypeEnum.enumValues`
  === `jobEventTypeSchema.options`, R3.6 契約整合）/ jobStatusEnum に suspended 含む / drizzle-zod insert（workflow 必須・
  userId null 可 / jobId+type 必須 / auditLog は tool 必須・jobId+userId null 可）。列内省は drizzle `getTableColumns`。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **193 passed**（185 → +8、回帰なし）。
  - `mise run typecheck` = exit 0。`mise run lint` = No fixes（`lint:fix` 整形後）。`lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（**新規依存ゼロ** ―― drizzle-orm/drizzle-zod は 8.3 既存）。
- **[env FLAG]** 実 DDL 適用（`CREATE TABLE`/FK/enum type）は live Postgres 必須（8.1 FLAG）。テーブル/契約/enum 整合は
  検証済み、DDL 実適用 + migration は 13.8 の store 実装 + Task 15 E2E（FLAG 解消環境）で兼ねる（8.3 と同一方針）。

### 学び / Act 申し送り

- **Task 13.7 完了**: 永続化スキーマ確立。enum は 11.2 契約と drift-guard で lockstep。
- **[申し送り → 13.8]** `apps/worker/src/stores.ts` が `job`/`job_event`/`audit_log` へ Drizzle insert（JobEvent→
  {jobId,type,ts,payload:rest} に分解、AuditEntry→auditLog 行）で `JobEventStore.append`/`AuditLogStore.insert` を実装。
  drizzle-kit migration（`CREATE EXTENSION vector` は既存、本タスクで 3 テーブル + 2 enum type 追加）を生成する必要あり
  ―― migration ファイルの所在（drizzle.config + out dir）を 13.8 で確定。`publisher.ts`(Redis) は別依存。
- **[申し送り → 13.8]** Job 行の生成タイミング: 14.1 の投入時 or worker 実行開始時に `job` を insert（jobEvent の
  FK 整合のため job 先行が必要）。status 遷移（pending→running→suspended→completed/failed）の書込点も 13.8/13.9 で確定。
- **次**: Task 13.8（実 store 実装 ―― Postgres stores + Redis publisher）。

---

## Task 13.8 — 実 store 実装（`apps/worker/src/{stores,publisher}.ts`, R3.6/5.5）

### Plan（対象・意図）

- **境界**: `apps/worker/src/stores.ts`, `apps/worker/src/publisher.ts`, `apps/worker/package.json`, `pnpm-workspace.yaml`。
  **Depends**: 13.3, 13.4, 13.7。**Requirements**: 3.6, 5.5。
- **意図**: 13.3/13.4 の注入ポート（JobEventStore/AuditLogStore/JobEventPublisher）へ Postgres/Redis の実実装を供給。
  13.7 テーブルへ書込み、Redis pub/sub で SSE(14.2) へ fan-out。

### Do（実装 ―― @vaz/rag の createDrizzle*Store 前例に準拠）

- **stores.ts**（Postgres, thin Drizzle adapter）: `createJobEventStore(db)` / `createAuditLogStore(db)` は
  `db: PgDatabase<PgQueryResultHKT>`（driver-agnostic、9.x と同型）を受け `db.insert(table).values(row)`。
  純マッパを分離・export: `toJobEventRow`（JobEvent の base=列 / ISO `ts`→Date / 残り判別フィールドを jsonb `payload` に
  ―― union 全体を round-trip）、`toAuditLogRow`（AuditEntry 1:1、args は DB 保持=R5.5）。エラーは sink 層へ伝播
  （events=fail-soft / audit=fail-loud は 13.3/13.4 が所有）。
- **publisher.ts**（Redis, 構造 seam）: `createJobEventPublisher(client, {channelPrefix?})` は最小 `RedisPublisher`
  seam（`publish(channel,message)`）を受け、`job:<jobId>` チャネルへ `JSON.stringify(event)` を publish（SSE は per-job 購読）。
  `redis` SDK は **import しない** ―― 実 `createClient()` 接続は 13.9(start.ts) が注入（テストは fake で infra 不要）。
- **deps 追加（境界内 package.json）**: `drizzle-orm@^0.45.2`（`PgDatabase` 型 import ―― apps/worker から解決するため直接宣言、
  lockfile 既存で download なし）+ `redis@^6.1.0`（13.9 の client 用。>24h 版で minimumReleaseAge クリア）。
- **supply-chain 監査（pnpm-workspace.yaml）**: `redis: false` を allowBuilds に default-deny 記録（redis@6.1.0 は install
  script 無し=published scripts は release のみ、@redis/* も純 JS ―― pg/8.6 前例のフェイルセーフ）。install = added 7,
  supply-chain policies pass、install-script ブロックなし。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: RED = `pnpm exec vitest run --project worker apps/worker/tests/{stores,publisher}.spec.ts` → module 未解決で 2 failed
  → GREEN = **10 passed**（toJobEventRow の base/payload 分解・空 payload・result 保持・job_event insert / toAuditLogRow の
  who/job/args/ts・null jobId+userId・audit_log insert / publisher の per-job channel + JSON round-trip + prefix + jobChannel）。
  DB/Redis 非依存（fake db は `insert().values()` 捕捉、fake redis は publish 捕捉）。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **203 passed**（193 → +10、worker project = 46 tests、回帰なし）。
  - `mise run typecheck` = exit 0（apps/worker が drizzle-orm/PgDatabase を解決 ―― 直接宣言で gate 通過）。
  - `mise run lint` = No fixes（`lint:fix` 整形後）。`lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（redis/drizzle-orm 追加後 churn 収束）。
- **[env FLAG]** 実 insert/publish（live Postgres/Redis）は 8.1 FLAG で未実行。マッピング + adapter 配線は fake で検証、
  実 I/O は 13.9 結線 + Task 15 E2E で兼ねる。

### 学び / Act 申し送り

- **Task 13.8 完了**: JobEvent/audit の Postgres store + Redis publisher を実装。sink（13.3/13.4）へ注入可能。
- **[申し送り → 13.9]** start.ts で `pg` Pool + `drizzle(pool, {schema})` を構築 → `createJobEventStore(db)`/`createAuditLogStore(db)`、
  `createClient({url: REDIS_URL})` + connect → `createJobEventPublisher(client)`。`createJobEventSink(deps, {store, publisher})` を
  `registerWorker(engine, buildWorkerDeps({db, audit: createAuditSink(deps,{store: auditStore})}), {emit: sink})` に結線。
- **[申し送り → 13.9/14.1]** `job` 行の生成（jobEvent FK 整合のため先行必須）+ status 遷移（pending→running→suspended→
  completed/failed）の書込点、および drizzle-kit migration（13.7 の 3 テーブル + 2 enum type の DDL 生成）を確定。
- **次**: Task 13.9（`inngest` 依存 + engine bootstrap ―― これで Phase 3 worker が end-to-end 結線可能に）。

---

## Task 13.9 — `inngest` 依存 + engine bootstrap（`apps/worker/src/{inngest,start}.ts`, R3.1/3.2/3.5）

### Plan（対象・意図）

- **境界**: `apps/worker/src/inngest.ts`, `apps/worker/src/start.ts`, `apps/worker/package.json`, `pnpm-workspace.yaml`, `apps/worker/Dockerfile`。
  **Depends**: 13.6, 13.8。**Requirements**: 3.1, 3.2, 3.5。
- **意図**: 具体エンジン(Inngest)を結線し、Phase 3 worker を end-to-end 起動可能にする（検証 GO で挙げたギャップ①の解消）。

### Do（実装）

- **inngest.ts（唯一のエンジン既知モジュール、adapters は純粋・testable）**:
  - `toApprovalGate(step)`: Inngest `step.waitForEvent` → engine-agnostic `ApprovalGate`（R3.5）。`if` で jobId+stepId 相関、
    timeout 既定 `7d`、event=`APPROVAL_EVENT`。null=timeout → ApprovalDecision へ写像。
  - `createInngestHandler(deps, options)`: Inngest ctx → `createJobHandler`/`runJob`。ctx.step を durable step に、
    `toApprovalGate(ctx.step)` を `waitForApproval` に注入。
  - `registerJobFunction(engine, deps, options)`: v4 **2 引数** `createFunction({id, retries, triggers:[{event:JOB_REQUESTED_EVENT}]}, handler)`。
  - `createInngestEngine({id?})`: `new Inngest({id})` を **dynamic import** で生成（重い SDK+OTel instrumentation を test/adapter ロード経路から除外）。
- **start.ts（合成ルート＝Dockerfile CMD target、bin/ingest.ts 前例）**: 純 `resolveWorkerEnv`（DATABASE_URL 必須、REDIS_URL 既定）は
  unit テスト。`main()` は pg Pool+drizzle / redis createClient / `connect({apps:[{client,functions}], instanceId})` を **dynamic import**
  で構築し、stores(13.8)+sinks(13.3/13.4)+audit を配線 → `registerJobFunction(engine, deps, {emit})` → Connect 常駐（`await connection.closed`、
  SIGINT/SIGTERM は connect() が処理）。
- **Dockerfile**: CMD を `node src/start.ts` に更新（旧 main.ts は export のみ＝即終了だった ―― ギャップ①解消）。
- **deps 追加**: `inngest@^4.11.0`（>24h）+ `pg@^8.13.1` + `@types/pg`（dev、start.ts の Pool）。`pnpm-workspace.yaml` allowBuilds に
  `inngest: false`（install script 無し failsafe）+ `protobufjs: false`（inngest Connect の推移依存 ―― postinstall は CLI 生成のみで
  ランタイム不要、default-deny 安全）を監査記録。install = added 192（初回）、supply-chain policies pass。

### 根本原因対応（v4 API ドリフト）

- タスク文言の `EventSchemas.fromZod` は **inngest v4 で削除**（v3 API、CHANGELOG のみ。v4 は Standard Schema）。盲目追従せず調査 →
  `new Inngest({id})`（schemas 無し）で生成。**ランタイム検証は不変**（runJob が `supervisorPlanSchema.parse` で検証）＝失うのは
  送信の compile-time typing のみ。誤って追加した `zod` dep は revert。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: inngest.spec.ts RED（module 未実装）→ GREEN **6 passed**（toApprovalGate の decision/timeout/reject 写像 + jobId/stepId 相関 +
  createInngestHandler の dispatch + 承認 suspend + registerJobFunction の config/handler）。start.spec.ts **3 passed**（env 解決/既定/fail-fast）。
  全て fake step/engine で **SDK サーバ非依存**。
- **回帰ゲート（全緑）**:
  - `mise run test:run` = **212 passed**（203 → +9、worker project = 55 tests、回帰なし）。
  - `mise run typecheck` = exit 0（Inngest v4 generics を `Inngest.Any`/`InngestFunction.Like` + edge cast で解決、apps/worker Done）。
  - `mise run lint` = No fixes（整形後）。`lint:model-ids` = ✅。
  - `pnpm install --frozen-lockfile` = `Already up to date`（inngest/pg 追加後 churn 収束、build-script ブロックなし）。
- **[env FLAG]** 実 Connect 接続 + engine 実行は Inngest サーバ(Docker)必須＝8.1 FLAG で未実行。adapters + 配線は fake で検証、
  live boot（restart-crossing R3.7 / 翌日承認 R3.8）は Task 15 耐久 E2E で兼ねる。

### 学び / Act 申し送り

- **Task 13.9 完了 → セクション 13 全 9 タスク（13.1–13.9）完了**。検証で挙げた **ギャップ①（inngest 依存+bootstrap）+ ②（テーブル+実 store）
  を両方解消**。worker は engine-agnostic コア（main.ts）+ Inngest 結線（inngest.ts/start.ts）+ 永続化（schema 13.7 / stores 13.8）+
  コンテナ（Dockerfile/compose 13.5）で **end-to-end 起動可能な構成**が揃った（実起動検証のみ Task 15 に残る）。
- **[申し送り → 14.x]** 14.1 `POST /api/jobs` は engine を作り `submitJob(engine, {jobId,userId,plan})`。14.3 `approve` は `submitApproval(engine, signal)`。
  web 側も `createInngestEngine()` で同一 client を共有（または engine を DI）。
- **[申し送り → 未タスク化]** (a) drizzle-kit migration（13.7 の 3 テーブル+2 enum の DDL 生成 / drizzle.config + out dir）、
  (b) `job` 行生成 + status 遷移（pending→running→suspended→completed/failed）の書込点（start.ts の handler or 14.1）、
  (c) step 単位の `requiresApproval` 有効化（現状 gate は wired だが未活性 ―― 破壊的 supervisor step 定義時に述語設定）。
  これらは Phase 3 実運用 or Task 14/15 で確定。
- **次**: Task 14.1（`apps/web/src/app/api/jobs/route.ts` ―― `POST /api/jobs`）。

---

## Task 14.1 — `POST /api/jobs`（`apps/web/src/app/api/jobs/route.ts`, R3.2）

### Plan（対象・意図）

- **境界**: `apps/web/src/app/api/jobs/route.ts`。**Depends**: 11.2, 13.2。**Requirements**: 3.2。
- **意図**: ジョブ投入(web)を実行(worker)から分離する薄い HTTP⇔engine アダプタを実装する
  ―― chat route(6.3)と同じ「オーケストレーションは route に置かない」規律を engine 投入にも適用。

### Do（実装）

- `supervisorPlanSchema`(`@vaz/schemas/workflows`, 11.2)で body を検証 → `jobId`(`randomUUID()`)を
  生成 → `JobRequest{jobId,userId:null,plan}` を組み立て → `submitJob(engine, request)`
  (`apps/worker/src/main.ts`, 13.2)で durable engine へ投入 → `{ jobId }` を **202 Accepted** で返す。
  `userId` は Phase 5 認証(18.2)まで null。
- **engine 取得は `@vaz/worker` を再利用**: `createInngestEngine()`(`apps/worker/src/inngest.ts`, 13.9)。
  13.9 の申し送り「web 側も `createInngestEngine()` で同一 client を共有」に従い、新規 engine 抽象や
  `packages/workflows` は作らず既存の engine-agnostic port(`DurableEngine`)を境界超えで再利用
  (ADR-2 に忠実 ―― web も Inngest SDK を直接 import しない)。
- **単一編集境界 × 新規依存**: `apps/web/package.json` へ境界拡張して `@vaz/worker: workspace:*` を
  追加(3.4/6.4 前例に同型)。`apps/worker` は `exports` map 非宣言(app であり packages/* の
  source-only wildcard 規約対象外)だが `moduleResolution:"bundler"` 配下では拡張子なし subpath
  (`@vaz/worker/src/{inngest,main}`)が legacy file 解決で到達可能。`inngest` SDK 自体は直接依存に
  追加せず(main.ts は型のみ・inngest.ts は dynamic import、apps/worker の node_modules から
  transitive 型解決 ―― 5.1 以来の direct-deps-only 方針を維持)。
- **Inngest 実クライアント × 構造的 `DurableEngine` port の型不一致**: `createInngestEngine()` の
  戻り値 `Inngest.Any` は `createFunction` の overload 形が `DurableEngine.createFunction` と構造的に
  一致せず `tsc` が拒否。`apps/worker/src/inngest.ts` の `InngestFunction.Like` cast 前例(edge glue)に
  倣い、route.ts の唯一の engine 境界点で `as unknown as DurableEngine` を明示 cast。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: `apps/web/tests/jobs-route.spec.ts`(chat-route.spec.ts 同型)で RED
  (`route.ts` 不在 → `Failed to resolve import`)→ GREEN(**4 passed**: 正常系 202+jobId 生成+
  submitJob 呼出し検証 / 不正 JSON 400 / スキーマ検証失敗 400 / submitJob 失敗 500)。
  `@vaz/worker/src/{inngest,main}` を `vi.mock` ―― 実 Inngest SDK・ネットワーク非依存。
- **回帰ゲート（全緑）**:
  - `mise run typecheck` = exit 0（`apps/web typecheck: Done`、`@vaz/worker/src/{inngest,main}` 含む
    全鎖を実 tsc で検査、cast で型不一致解消）。
  - `mise run test:run` = **216 passed**（212 → +4、回帰なし）。
  - `mise run lint` = `Checked 98 files … No fixes applied.`（biome organizeImports 順に整形）。
    `mise run lint:model-ids` = ✅。
  - `mise run audit` = clean。`pnpm install --frozen-lockfile` = Already up to date
    （`@vaz/worker` importer 追加後 churn 収束）。

### 学び / Act 申し送り

- **Task 14.1 完了**: `POST /api/jobs` が `SupervisorPlan` 検証 → `submitJob` で engine 投入 →
  `{ jobId }`(202)を返す薄いアダプタとして確立。13.9 の申し送り(engine 共有方針)を解消。
- **[非スコープ → 未タスク化を継続]** `Job` 行(13.7)の INSERT・status 遷移は 14.1 でも未実装
  （`stores.ts` に `JobStore` が無い ―― 13.9 申し送り(b)を継承、Phase 3 実運用 or 後続タスクで確定）。
- **次**: Task 14.2（`api/jobs/[id]/stream/route.ts` ―― SSE Route Handler、`JobEvent` 判別共用体配信）。

---

## Task 14.2 — SSE Route Handler（`apps/web/src/app/api/jobs/[id]/stream/route.ts`, R3.6）

### Plan（対象・意図）

- **境界**: `apps/web/src/app/api/jobs/[id]/stream/route.ts`。**Depends**: 11.2, 13.3。
  **Requirements**: 3.6。
- **意図**: worker が `JobEvent` 判別共用体を publish する Redis チャンネル(13.8
  `createJobEventPublisher`)に subscribe し、browser へ SSE で中継する薄い subscribe⇔SSE
  アダプタを実装する。route.ts が唯一の Redis 依存点(ADR-2: web は Redis SDK を他所へ漏らさない)。

### Do（実装）

- `GET`(Next.js 16 の非同期 `params`: `{ params: Promise<{ id: string }> }`)で `jobId` を取得 →
  リクエストごとに新規 `redis`(node-redis v6, `createClient`)クライアントを構築 → 13.8
  `apps/worker/src/publisher.ts` の `jobChannel(jobId)` で命名した Redis チャンネルへ subscribe →
  受信メッセージ(worker が 13.3 `jobEventSchema` で検証・publish 済みの JSON 文字列)を
  そのまま `data: <message>\n\n` として `ReadableStream` へ enqueue し `Response`(`Content-Type:
  text/event-stream`)を返す。`export const dynamic = "force-dynamic"` で静的化を無効化。
- **ブラウザ切断時のクリーンアップ**: `ReadableStream.cancel()`(fetch 標準 ―― 消費側切断で
  自動発火)で `client.unsubscribe(channel)` → `client.quit()` を best-effort(エラーは
  ログのみ、再 throw しない)実行。
- **[設計] DB replay は非スコープ**: 13.3 `events.ts` の doc コメントが「DB(履歴)・Redis(生配信)の
  どちらか/両方/どちらも無し」を許容すると明記している通り、14.2 は生配信(Redis pub/sub)のみを
  配線。`job_event` テーブル(13.7)からの履歴 replay(遅れて subscribe したクライアントへの
  巻き戻し)は 13.8 `stores.ts` に read 系メソッドが無く(`JobEventStore.append` のみ)、Task 13 の
  凍結境界を再度開くことになるため未タスク化(14.1 の「非スコープ → 未タスク化」precedent)。
- **単一編集境界 × 新規依存(14.1 と同型)**: `apps/web/package.json` へ境界拡張して
  `"redis": "^6.1.0"`(`apps/worker` と同バージョン)を追加。`allowBuilds`(pnpm-workspace.yaml)は
  既に `redis: false`(lifecycle script 無し・audited、13.8)としてワークスペース全体に適用済みの
  ため追加監査は不要。
- **Redis チャンネル命名の単一ソース化**: web 側に `jobChannel` を複製せず、publish 側
  (`apps/worker/src/publisher.ts`, 13.8)が export する `jobChannel()` を
  `@vaz/worker/src/publisher` から直接 import ―― 14.1 が `@vaz/worker/src/{inngest,main}` を
  境界超えで再利用した precedent と同型。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: `apps/web/tests/jobs-stream-route.spec.ts` で RED(`route.ts` 不在 →
  `Failed to resolve import`)→ GREEN(**3 passed**: (a) `job:<jobId>` へ subscribe し publish
  メッセージを `data: <message>\n\n` として転送 / (b) `stream.cancel()` → `unsubscribe`/`quit`
  呼出し / (c) `client.connect()` reject → `controller.error()` でストリーム消費側に伝播)。
  `redis` を `vi.mock` ―― 実 Redis・ネットワーク非依存。
- **回帰ゲート（全緑、`mise run check`）**:
  - `typecheck` = exit 0（`apps/web`/`apps/worker` 含む全鎖 tsc）。
  - `test:run` = **219 passed**（216 → +3、回帰なし）。
  - `lint` = `Checked 100 files … No fixes applied.`（`noNonNullAssertion`/
    `noUnsafeOptionalChaining` を型ガード関数(`getReader`)へリファクタして解消）。
  - `lint:model-ids` = ✅。`audit` = `No known vulnerabilities found`。
  - `pnpm install` = `Lockfile passes supply-chain policies`（`redis` importer 追加後 churn 収束）。

### 学び / Act 申し送り

- **Task 14.2 完了**: `GET /api/jobs/:id/stream` が worker → Redis → SSE → browser の生配信経路を
  確立。13.8 の publish 側実装と対で R3.6 が実配線された。
- **[非スコープ → 未タスク化を継続]** DB(`job_event`)からの履歴 replay は未実装 ―― 遅れて
  subscribe したクライアントは接続時点以降の live イベントのみを受信する。`JobEventStore` に
  list 系メソッドを追加する後続タスク化が必要(Phase 3 実運用 or 後続タスクで確定)。
- **次**: Task 14.3（`api/jobs/[id]/approve/route.ts` ―― 承認イベント受信 → 中断中ワークフロー
  再開シグナル）。

---

## Task 14.3 — 承認 Route Handler（`apps/web/src/app/api/jobs/[id]/approve/route.ts`, R3.4/3.5）

### Plan（対象・意図）

- **境界**: `apps/web/src/app/api/jobs/[id]/approve/route.ts`。**Depends**: 11.2。
  **Requirements**: 3.4, 3.5。
- **意図**: 承認 UI(Task 14.5)が送る承認イベント(`{ toolCallId, decision, args? }`, plan.md
  Interfaces/Contracts)を受け、13.6 `apps/worker/src/main.ts` の `submitApproval` へブリッジして
  中断中ワークフローへ resume シグナルを送出する薄い HTTP⇔engine アダプタを実装する。14.1/14.2 と
  同型の単一 route.ts 境界。

### Do（実装）

- `POST`(Next.js 16 の非同期 `params`: `{ params: Promise<{ id: string }> }`)で `jobId` を取得 →
  body を手動検証(`toolCallId: string(非空)` / `decision: "approve"|"reject"` / `args?: unknown`)
  → `ApprovalSignal{ jobId, stepId: toolCallId, approved: decision==="approve", args? }` を組み立て
  → `createInngestEngine()`(13.9 再利用, 14.1 と同型)で engine を取得 → `submitApproval(engine,
  signal)` で `APPROVAL_EVENT` を送出 → `{ ok: true }` を 202 で返す(fire-and-forget、resume 完走は
  待たず進捗は 14.2 SSE で配信 ―― 14.1 の decoupling precedent を継承)。
- **[解決] `toolCallId`(HTTP 契約) × `stepId`(engine 相関キー) の命名差**: plan.md の HTTP 契約は
  `toolCallId` を明記するが、13.6 で確定した中断/再開の実粒度は AI SDK の個別 tool call ではなく
  supervisor plan の **step**(`createDurableStepRunner` は `requiresApproval(stepId)`/
  `engineStep.run("approval:"+stepId, …)` で stepId 相関、`ApprovalGate`/`ApprovalSignal` も
  `stepId` フィールド)。Approval エンティティ(plan.md データモデル)や toolCallId→stepId の
  マッピング store は未実装(13.7/13.8 は JobEvent/AuditLog のみ)。よって HTTP 契約のフィールド名
  はそのまま(`toolCallId`)維持しつつ、その**値**を engine 相関キー(`stepId`)として転送する設計に
  した ―― 承認 UI(14.5)は `step-start` `JobEvent` の `stepId` を読み、それを `toolCallId` として
  送信する契約になる(13.6 申し送り「承認 UI は step-start イベント(kind)+ requiresApproval 述語で
  判定」と整合)。新規 schema/store は追加せず、既存 2 契約(HTTP/engine)を単一 route.ts でブリッジ
  するだけに留めた。
- **単一編集境界 × 新規依存ゼロ**: `@vaz/worker`(`src/{inngest,main}`)への依存は 14.1 で既に
  `apps/web/package.json` へ境界拡張済み ―― 14.3 は新規依存を追加しない。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: `apps/web/tests/jobs-approve-route.spec.ts`(jobs-route.spec.ts 同型)で RED
  (`route.ts` 不在 → `Failed to resolve import`)→ GREEN(**6 passed**: (a) `decision:"approve"` →
  `submitApproval` を `{jobId,stepId,approved:true,args}` で呼出・202・`{ok:true}` / (b)
  `decision:"reject"` → `approved:false`・`args` 未指定時はキー省略 / (c) 不正 JSON → 400・未呼出 /
  (d) `toolCallId` 欠落 → 400・未呼出 / (e) `decision` が approve/reject 以外 → 400・未呼出 / (f)
  `submitApproval` 失敗 → 500)。`@vaz/worker/src/{inngest,main}` を `vi.mock` ―― 実 Inngest SDK・
  ネットワーク非依存。
- **回帰ゲート（全緑、`mise run check`）**:
  - `typecheck` = exit 0（apps/web/apps/worker 含む全鎖 tsc、Done）。
  - `test:run` = **225 passed**（219 → +6、回帰なし）。
  - `lint` = `Checked 102 files … No fixes applied.`。`lint:model-ids` = ✅。
  - `audit` = `No known vulnerabilities found`。新規依存ゼロ(`pnpm install` 不要 ―― package.json
    無変更)。

### 学び / Act 申し送り

- **Task 14.3 完了**: `POST /api/jobs/:id/approve` が HTTP 契約(`toolCallId`/`decision`/`args?`)を
  engine 相関キー(`stepId`/`approved`/`args?`)へブリッジし、`submitApproval` で中断中ワークフローの
  resume シグナルを送出する薄いアダプタとして確立。13.6(worker 側 checkpoint/承認配線)と対で
  R3.4/3.5 が実配線された。
- **[申し送り → 14.5]** 承認 UI(`ApprovalPanel.tsx`)は `step-start` `JobEvent` の `stepId` を
  `toolCallId` として POST body に載せる契約(本タスクの「命名差」解決を参照)。`ApprovalDeniedError`
  (rejected/expired/misconfigured)は engine 内部で throw され、workflow 失敗として 14.2 の `error`
  `JobEvent` に流れる想定 ―― 14.5 はその `error` イベントで terminal 状態を描画する(13.6 申し送り)。
- **[非スコープ → 未タスク化を継続]** `Approval` 行(plan.md データモデル)の INSERT・状態遷移は
  14.3 でも未実装 ―― 14.1/14.2 の「非スコープ → 未タスク化」precedent を継承(Phase 3 実運用 or
  後続タスクで確定)。
- **次**: Task 14.4（`features/jobs/useJobStream.ts` ―― SSE 消費フック）。

## Task 14.4: `features/jobs/useJobStream.ts` — SSE 消費フック

### Plan（計画）

- **境界**: `apps/web/src/features/jobs/useJobStream.ts`。**Depends**: 14.2。
  **Requirements**: 3.6。
- **意図**: `GET /api/jobs/:id/stream`(14.2)が配信する `JobEvent` 判別共用体を `"use client"`
  フックで消費し、承認 UI(14.5)や進捗表示コンポーネントが購読できる状態(`events`/`latestEvent`/
  `status`/`error`)に変換する。

### Do（実装）

- `useJobStream(jobId: string | null | undefined)` → `{events: JobEvent[], latestEvent,
  status: "connecting"|"open"|"closed"|"error", error}` を返すフック。`jobId` 変化ごとに
  `useEffect` で `fetch(/api/jobs/:id/stream, {signal})` → `response.body`
  (`ReadableStream<Uint8Array>`)を読み進め、終了/失敗/unmount で `AbortController.abort()`。
- **[設計] SSE フレーム解析は自前実装せず `ai` の `parseJsonEventStream` を再利用**: 既存依存
  `ai`(`@ai-sdk/provider-utils` 再 export)の `parseJsonEventStream({stream, schema})` が内部で
  `EventSourceParserStream` により `data: <json>\n\n` を分解し `jobEventSchema`(11.2)検証済みの
  `ParseResult<JobEvent>` を yield する ―― 14.1-14.3 の `@vaz/worker` 境界超え再利用と同型
  (reuse-over-reinvent)。ブラウザ標準 `EventSource` は不採用(`ReadableStream<Uint8Array>` 入力を
  要求する `parseJsonEventStream` と噛み合わない ―― `EventSource` はそれを公開しない)。
- **[設計] 不正フレームは drop-and-log**: `ParseResult.success===false` は `console.error` に記録し
  次フレームへ継続、`error` state には反映しない ―― worker 側 `createJobEventSink`(13.3)の
  「壊れたイベントはログして捨てる」契約と対称(1 件の不正フレームで購読全体を落とさない)。
- **[設計] `jobId` が null/undefined の間は fetch 発火なし・`status:"closed"`**: 承認 UI(14.5)など
  ジョブ未確定の呼び出し元が安全に呼べる契約。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: `apps/web/tests/useJobStream.spec.ts` で RED(フック不在 →
  `Failed to resolve import`)→ GREEN(**6 passed**: (a) `jobId:null` → fetch 未呼出・
  `status:"closed"` / (b) 正常系 = 2 件の妥当な `JobEvent` を順次累積・ストリーム終了で
  `status:"closed"` / (c) 不正フレーム混在 → 妥当フレームのみ蓄積・`console.error` 呼出・`error`
  は null / (d) `fetch` reject → `status:"error"`・`error.message` 伝播 / (e)
  `response.ok===false` → `status:"error"` / (f) unmount → `signal.aborted===true`)。
  `@testing-library/react` の `renderHook`/`waitFor`、`fetch` を `vi.stubGlobal` で差し替え、
  `Response`/`ReadableStream`(jsdom でも Node 組込みグローバルとして利用可能、14.2 の
  `jobs-stream-route.spec.ts` と同じ前提)で SSE バイト列を模擬 ―― 実 Route Handler・ネットワーク
  非依存。
- **回帰ゲート（全緑、`mise run check`）**:
  - `typecheck` = exit 0（apps/web/apps/worker 含む全鎖 tsc、Done）。
  - `test:run` = **231 passed**（225 → +6、回帰なし）。
  - `lint` = `Checked 104 files … No fixes applied.`。`lint:model-ids` = ✅。
  - `audit` = `No known vulnerabilities found`。新規依存ゼロ(`ai`/`@vaz/schemas` は既存依存、
    `pnpm install` 不要 ―― package.json 無変更)。

### 学び / Act 申し送り

- **Task 14.4 完了**: `useJobStream` が 14.2 SSE エンドポイントの消費⇔状態変換アダプタとして確立。
  `parseJsonEventStream` 再利用により SSE パーサ自前実装ゼロで R3.6 の「型付き判別共用体」契約を
  満たした。
- **[申し送り → 14.5]** 承認 UI(`ApprovalPanel.tsx`)は本フックの `events`(または `latestEvent`)
  から `type==="step-start"` を検出して承認要否を判定する想定(13.6 申し送り「承認 UI は
  step-start イベント(kind)+ requiresApproval 述語で判定」)。`stepId` はそのまま 14.3 route の
  `toolCallId` として POST body に載せる契約(14.3 の「命名差」解決を継承)。
- **次**: Task 14.5（`features/jobs/ApprovalPanel.tsx` ―― 承認 UI、approve/reject/edit args、
  `"use client"`）。

---

## Task 14.5 — 承認 UI（`apps/web/src/features/jobs/ApprovalPanel.tsx`, R3.4）

### Plan（対象・意図）

- **境界**: `apps/web/src/features/jobs/ApprovalPanel.tsx`（単体）。**Depends**: 14.3（14.4 は
  既完了で実質の入力契約）。**Requirements**: 3.4。
- **意図**: `useJobStream`(14.4)の `events` から承認待ちステップを導出し、承認/拒否/引数編集の
  決定を `POST /api/jobs/:id/approve`(14.3)へ送信する `"use client"` HITL UI を実装する。

### Do（実装）

- `ApprovalPanel({ jobId, requiresApproval? })` を新設。`requiresApproval?: (step:{stepId,kind}) =>
  boolean`（既定 `() => false`）は worker `requiresApproval(stepId)` 述語のクライアント側ミラー
  （do.md 13.6 申し送り「承認 UI は step-start イベント(kind)+ requiresApproval 述語で判定」、
  `@vaz/agents/approval-policy` の `isDestructive`/`destructiveTools` と同型の belt-and-suspenders）。
  既定を「何も承認待ちにしない」にしたのは、worker 側ゲートも「配線済みだが未活性」（do.md 13.9
  申し送り(c)）だからで、パネル側が独自に destructive kind を推測しないための対称設計。
- `findPendingStep(events, requiresApproval)`: `step-start` があり同じ `stepId` の
  `completion`/`error` がまだ無い最新ステップを承認待ちとする（supervisor の直列 dispatch により
  実際は常時 1 件以下だが防御的に全件スキャン）。
- 引数編集は事前入力なしの素の JSON テキスト（`TextInput`、既存 `global.scss` 登録済み Carbon
  コンポーネントを再利用 ―― 新規コンポーネント追加による `global.scss` 改変を避け単一ファイル境界を
  維持）。理由: `createDurableStepRunner`(13.6)は specialist 関数実行**前**に承認 gate へ await する
  ため、`tool-call` イベント（specialist 内部からのみ発火）はこの時点で存在せず、事前入力できる
  「元の引数」がクライアントに無い。未入力時は 14.3 の「`args` 未指定時はキー省略」契約通り `args`
  キー自体を省略。拒否時は編集内容を送らない。
- `ApprovalDeniedError`(13.6, `rejected`/`expired`/`misconfigured`)は `error` `JobEvent.message` の
  `` `Approval ${reason} for step "${stepId}".` `` 形状として届く ―― 正規表現で理由を抽出し専用の
  終端バナーを表示（13.6 申し送り）。非一致の `error` は汎用エラー、さらにフォールバックで
  `useJobStream` 自身の接続エラーも表示。優先順位: 承認フォーム > 拒否バナー > 汎用エラー >
  接続エラー > 待機メッセージ。
- ローカル state（引数テキスト/送信中/送信エラー/決定済み）は子コンポーネント
  `ApprovalDecisionForm` に切り出し、親が `key={pendingStep.stepId}` を付与して新ステップ出現時に
  remount でリセット。

### 根本原因対応（lint エラー）

- 当初 `useEffect(() => {...}, [pendingStep?.stepId])` でリセットを実装したが、effect 本体が
  `pendingStep` を読まないため biome `lint/correctness/useExhaustiveDependencies` が「不要な依存」
  と検出。依存配列を削ると本来のリセット機能が失われる根本原因不一致であり blind fix ではなく、
  子コンポーネント + `key` remount という設計へ変更して解決（lint の指摘は「このパターンを
  useEffect で書くな」という信号として妥当だった）。

### 検証エビデンス（Verification Gate）

- **RED→GREEN**: `apps/web/tests/ApprovalPanel.spec.tsx` で RED（`ApprovalPanel` 不在 →
  `Failed to resolve import`）→ GREEN（**10 passed**）。`@/features/jobs/useJobStream` を `vi.mock`
  して制御された `events` を注入、`fetch` を `vi.stubGlobal` で差し替え ―― 実 SSE・実 Route Handler
  非依存。ケース: (a) 承認待ちなし→待機メッセージ、(b) `requiresApproval` true の `step-start`→
  フォーム表示、(c) false(既定)→フォーム非表示、(d) `completion` 済み→フォーム非表示、(e) 承認→
  編集 JSON 付き POST、(f) 拒否→`args` キー無し POST、(g) 不正 JSON→未送信+エラー表示、(h) 送信
  API 失敗→エラー表示、(i) `Approval rejected`→拒否理由バナー、(j) 無関係なエラー→汎用エラー。
  （中間で `userEvent.type` の `{`/`}` エスケープ誤りにより 2 件が意図せず落ちたが、
  `{{literal}` 記法（開き括弧のみエスケープ、閉じ括弧はエスケープ不要）に修正し解消 ―― JSON
  パース自体の実装バグではなくテスト記述の誤りだった。）
- **回帰ゲート（全緑、`mise run check`）**:
  - `typecheck` = exit 0（apps/web/apps/worker 含む全鎖 tsc、Done）。
  - `test:run` = **241 passed**（231 → +10、回帰なし）。
  - `lint` = `Checked 106 files … No fixes applied.`。`lint:model-ids` = ✅。
  - `audit` = `No known vulnerabilities found`。新規依存ゼロ（`TextInput`/`Tag`/`Button`/
    `InlineNotification`/`Tile` は既存 `global.scss` 登録済み Carbon コンポーネント、
    `pnpm install` 不要 ―― package.json/global.scss 無変更）。

### 学び / Act 申し送り

- **Task 14.5 完了 → セクション 14（Web ジョブ API・SSE・承認 UI）全 5 タスク完了**。
  `POST /api/jobs`(14.1) → SSE 配信(14.2) → 承認受信(14.3) → クライアント消費(14.4) → 承認 UI(14.5)
  まで HITL の HTTP⇔engine⇔UI 往復が確立（R3.2/3.4/3.5/3.6）。
- **[非スコープ → 未タスク化を継続]** (a) edited `args` の specialist 実行への反映
  （`createDurableStepRunner` は `decision.approved` のみ判定、`args` は素通り、13.6 由来のギャップ）、
  (b) `ApprovalPanel` の実ページ配線（`Chat`/`page.tsx` からの使用）と `requiresApproval` predicate
  の実体化（worker 側 gate 活性化と対で必要、13.9 由来のギャップ）―― いずれも 14.5 の単一ファイル
  境界外、Phase 3 実運用または後続タスクで確定。
- **次**: Task 15（承認中断→再開の耐久性 E2E）。
