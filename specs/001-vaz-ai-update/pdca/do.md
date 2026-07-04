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
