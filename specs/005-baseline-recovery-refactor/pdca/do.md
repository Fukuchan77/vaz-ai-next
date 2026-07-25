# 005-baseline-recovery-refactor — PDCA Do

## Task 1: CI ゲートの回復(R1)

### 1.1 棚卸し

`pnpm install`(既に up to date)→ `pnpm audit --audit-level=moderate --json` で
2 件の high advisory を再確認(node_modules は既にインストール済みの状態で開始 — spec 起票時の
「未インストール」前提は本セッションでは成立せず、実解決版を直接確認できた):

| Advisory | Package(実解決版) | vulnerable | patched | 経路(実測) |
| --- | --- | --- | --- | --- |
| GHSA-r28c-9q8g-f849 | `postcss@8.5.16` | `<=8.5.17` | `>=8.5.18` | `next`/`next-auth`/`inngest`(prod)+ `vite`/`vitest`(dev) 経由、既存 `postcss@<8.5.10` override の射程外 |
| GHSA-mh99-v99m-4gvg | `brace-expansion@2.1.2` | `<=5.0.7` | `>=5.0.8` | `minimatch`(`openapi-typescript>@redocly/openapi-core` と `inngest>...>gaxios>rimraf>glob` の両経路、dev-only)経由、既存 `brace-expansion@>=2.0.0 <2.1.2: ^2.1.2` override は 2.x 系内のみで patched major(5.x)に届かない |

`pnpm why postcss` / `pnpm why brace-expansion` で「Found 1 version」= 両方ともツリー全体が単一の
解決版に dedupe されていることを確認(=「別の 2.x 依存線」は現状存在しない)。

### 1.2 override 是正(tier 3)

- `postcss@<8.5.10` → `postcss@<8.5.18`(セレクタを patched 境界へ拡大)、target は `^8.5.18` に変更。
  実解決 `postcss@8.5.22` を確認。
- `brace-expansion@>=2.0.0 <2.1.2` は**セレクタは変更せず**(実際の依存者 `minimatch@^2.0.1`/
  `^2.0.2` の宣言範囲と重なるのはこのセレクタのみ — plan.md が想定した「5.x 系の新規セレクタ追加」を
  試したが、`^2.0.1` の要求範囲とは重ならず無効だったため採用せず)、target のみ `^2.1.2` → `^5.0.8`
  に変更(pnpm override は major を跨いで強制解決できる)。実解決 `brace-expansion@5.0.8` を確認。
- 両エントリのコメントを `docs/dependency-policy.md` §3 の規約(vulnerable range / upstream /
  GHSA-ID / patched / 撤去条件)に合わせて更新。

### 1.3 ignoreGhsas 退避の要否判断

`pnpm install` が新 target(`postcss@^8.5.18` → 8.5.22 解決、`brace-expansion@^5.0.8` → 5.0.8 解決)
をエラーなく解決した(`minimumReleaseAge`(1440 分)未達での失敗は発生しなかった)。したがって
tier 4(`auditConfig.ignoreGhsas`)への退避は不要と判断。`minimumReleaseAge` 自体は変更していない。

### 1.4 `docs/dependency-policy.md` §6 更新

`postcss@<8.5.10` 行を supersede(本 spec で判断を下したため「対象外」文言を撤去し、新セレクタ・
新根拠・撤去条件を記載)。`brace-expansion@>=2.0.0 <2.1.2` 行の撤去条件を新 target(`^5.0.8`)に
即して更新。表見出しの検証日を 2026-07-25(spec 005 再検証)に更新。

### 1.5-1.6 `py:check` の pytest collection 修復(test-first で検証)

**RED→GREEN の再現手順(重要な発見を含む)**:

1. 最初に `rm -rf .venv && uv sync && uv run pytest` を実行 → **green(61 passed)**。
   spec の前提(`ModuleNotFoundError: No module named 'app'`)が再現しなかった。
2. 原因調査: `uv run python -c "import sys; print(sys.path)"` で `sys.path[0]` が
   rootdir(`services/agent`)であることを確認 → ローカルシェルの `PYTHONPATH=.` が
   既に rootdir を注入しており、バグをローカルで隠していた(グローバル shell 環境由来、
   このリポジトリの設定ではない)。
3. `mise.toml` が `uv = "0.9"` を pin している一方、ローカル `uv`(`which uv`)は
   mise の "latest" インストール(0.11.32)を指していた版違いも確認したが、これは今回の
   再現には無関係だった(pinned 0.9.30 でも `PYTHONPATH` が漏れていれば green になることを確認)。
4. **実際の CI ログを取得して原因を確定**: `gh run view 30100905550 --log-failed` で
   2026-07-24T14:25:49Z の実際の失敗を確認:
   `ImportError while loading conftest ... tests/conftest.py:30: from app.eval.llama import
   PydanticAIJudgeLLM / ModuleNotFoundError: No module named 'app'`。CI ランナー(GitHub Actions,
   ubuntu-latest)には `PYTHONPATH` 汚染が無いため、そちらが正しい再現環境だった。
5. `env -u PYTHONPATH` でローカル環境変数を除去して再現 → **RED(ModuleNotFoundError 再現)を確認**。
6. `[tool.pytest.ini_options]` に `pythonpath = ["."]` を追加(`[tool.uv] package = false` は維持)。
7. 同じ `env -u PYTHONPATH` の下で再実行 → **GREEN(61 passed)を確認**。
8. `services/agent/README.md` の `uv run pytest` 節に rootdir 実行前提の注記を追加。
9. `uv.lock` を `grep '^name = "app"'` で確認 → 0 件。サードパーティ `app` モジュールとの衝突なし
   (plan.md Error Handling の懸念は該当せず)。

**学び(pdca act.md へ引き上げ候補)**: ローカル shell の環境変数汚染(今回は `PYTHONPATH=.`)は
CI 実行環境と異なる「見えないローカル優位」を作り、004 と同型の「ローカル green はCI green を
保証しない」を再演しうる。再現テストは `env -u <該当変数>` で疑わしい環境変数を明示的に除去してから
行うべき。

### 1.7 検証ゲート

- `pnpm audit --audit-level=moderate` → `No known vulnerabilities found`(exit 0)
- `pnpm exec vitest run` → 574 passed(54 test files)。004 記録の 573 passed/1 skipped から
  1 件増(既存のskipped扱いテストが安定してpassした可能性 — Task 1 はテストファイルを一切
  変更していないため、この差は Task 1 の変更由来ではない。Task 3 の refactor-only 件数照合の
  ベースラインとして 574 passed / 0 skipped を採用する)。
- `NODE_ENV=production mise run build` → `next build` 完走(compiled successfully, 6 routes)。
- `mise run check`(lint + typecheck + test:run + audit + lint:model-ids)→ 全 green。
- `env -u PYTHONPATH mise run py:check` → ruff all checks passed / pyright 0 errors / pytest 61 passed。
- `git diff --stat mise.toml` → 差分ゼロ(`[tasks.check]` の依存構成不変を確認、R1.5)。
