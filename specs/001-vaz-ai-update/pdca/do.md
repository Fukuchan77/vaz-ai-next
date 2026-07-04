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
