# 005-baseline-recovery-refactor — Act(申し送り・学び)

日付: 2026-07-26。

## Outcome

- **CI ゲートを実地で回復**: `pnpm audit` の新規 high advisory 2 件(`postcss`/`brace-expansion`)を
  override の射程是正(tier 3)で解消、`py:check` の pytest collection 失敗を `pythonpath = ["."]`
  で解消。**ローカル green ではなく CI 実績**(run id `30157580758`、`005-baseline-recovery-refactor`
  ブランチ)として `gate` の初 green を確認した(台帳 C-2 の前提ブロック解除)。
- **DB baseline DDL を起票**: `packages/db/drizzle/0000_baseline.sql` を `schema.ts` から導出し、
  DB 接続不要のドリフト検出テスト(`schema-ddl.spec.ts`)と `mise run db:migrate`
  (`packages/db/bin/migrate.ts`)を追加。docker 実走(2026-07-26)で fresh DB migrate・冪等再実行・
  `psql` 実在確認を完了し、drizzle-kit 非採用の判断を ADR-0002 に記録した。
- **infra seam を単一化**: console-`Logger` 4 重複 → `@vaz/config` の単一実装、`DATABASE_URL`/
  `REDIS_URL`/`emptyToUndefined` の Zod 圏外重複 → `@vaz/schemas/infra-env` + `env-helpers.ts`。
  refactor-only を 624→625 passed の件数照合で立証。
- **README/`.env.example`/review doc を整合**: root `src/` 構成の記述を全面刷新、broken link
  解消、`.env.example` を 5→28 件へ補完(ユーザーが `~/.claude/settings.json` の `deny` により
  エージェントから直接書けない `.env.*` を手動反映)。
- **実 DB・実 E2E 実走で 2 件の実挙動欠陥を検出・是正**(DB 未接続のユニットテストでは捕捉不能
  だった欠陥): (1) `db:migrate` の fail-loud 案内が enum 衝突(`42710`)を取りこぼす、
  (2) `env-helpers` の拡張子なし相対 import が Node native ESM(ingest CLI)で解決不能。
  いずれも「実 DB / 実 E2E を実走するまで検出できない」クラスの欠陥であり、Task 2.10/5.2 が
  前セッションで honest-skip としていたことの価値を裏付けた。
- **004 act.md 申し送り 1 / 002 act-final M3 PENDING を「executable」まで前進**: locator E2E の
  実スタック実走は end-to-end で動作することを実証したが、決定論的 green は allowlisted ローカル
  モデル(`llama3.2`)の tool-calling 限界により未達 — Anthropic provider での 1 回の実走
  (運用者アクション、台帳 C-4)を最終クローズの条件として残した。

## Learnings → Rules Mapping

| Learning | Candidate rule / steering update |
|---|---|
| **ローカル green を完了条件にしない** — 004 は「全ゲート green」を宣言したが、同一コミットの CI では `audit`/`py-check` が赤だった(ローカル `.venv` の既存状態、ローカル `PYTHONPATH` 汚染に依存した見せかけの green)。本 spec の起点そのものがこの誤りの再発だった | **CI 実績(run id 付き)を完了の唯一の判定基準とする**。ローカル実行はデバッグ手段であり、報告可能な「green」の主張はワークフロー run の conclusion に基づくものに限る。再現テストでは `env -u <疑わしい変数>` で不可視のローカル優位を明示的に除去してから判定する |
| ドリフト検出テスト(DB 接続不要)は「baseline SQL と schema.ts の整合」しか保証せず、「実 PostgreSQL に対する実行可能性」と「実 E2E での decision-making 挙動」は別の保証範囲 — 実際、2.10/5.2 の実走でのみ検出できた欠陥が 2 件あった(enum 衝突コード漏れ、ESM 解決不能) | **「DB 接続不要のユニットテストが green」と「実インフラでの実行確認」は異なる保証層として扱い、後者を honest-skip した場合は次回セッションで解消する優先度を上げる**。到達環境が使えるようになった瞬間に先送りしていた実走を消化する運用を徹底する |
| vitest/Next/tsc は拡張子なし相対 import(`from "./env-helpers"`)を bundler/loader 解決で通すが、Node native ESM で走る composition-root CLI(`node bin/ingest.ts`)だけが解決に失敗する — 既存ゲート(型チェック・単体テスト・build)は全て green のまま、実走で初めて露見した | AGENTS.md の既存記載(「Self-referencing package specifiers」)は正しいが、**新規モジュール分割(`env-helpers.ts` のような内部 helper の抽出)を行う際は grep で `from "\./` の拡張子なし相対 import が native ESM で実行される CLI から到達していないかを確認する**チェック項目として運用する |
| dep-graph の leaf 制約(`@vaz/db` は `@vaz/config`/`@vaz/schemas` の runtime import 不可)により生じる「意図的な複製」は、複製箇所の一方にだけ理由説明の docstring が付き他方に付かないという非対称が起きやすい(5.1 adversarial review が検出した 1 件がこの型) | **同一の設計制約に由来する複数の複製箇所は、1 箇所に docstring を書いたら他の全箇所にも対称の docstring を書くタスクとして扱う**(`_Boundary:_` に複製箇所を全件列挙する) |
| `.env.example` のようなユーザーのグローバル permission 設定(`deny: ["Write(.env*)"]`)で保護されたファイルは、エージェントが確定した内容をチャットで提示し、反映はユーザーの手動作業に委ねるしかない — 迂回策(Bash 経由の cat/heredoc)は意図的なセキュリティ境界の回避になるため取らない | **`deny` で保護されたファイルへの変更が必要な task では、確定内容をチャットに提示し「ユーザーによる手動反映」を選択肢として明示する**。`git diff`/`git diff --stat` は同じ deny ルールの対象外であることが多く、反映後の検証経路として使える |

## Next Actions(申し送り)

1. **`ANTHROPIC_API_KEY` を Secrets へ追加**(台帳 C-1/C-4 共通): 追加後、
   `mise run test:e2e:ollama` 相当を Anthropic provider で 1 回実走し locator-citation が
   決定論的に green になることを確認 → 004 act.md 申し送り 1 と 002 act-final の M3 PENDING を
   最終クローズする。
2. **branch protection の新規作成**(台帳 C-2): 前提(`gate` 初 green)は本 spec で解消済み。
   `gh api repos/<org>/<repo>/branches/main/protection -X PUT` で `gate` を唯一の required
   check に設定する。
3. **次回棚卸しは台帳 A のトリガー成立チェックから開始する**: A-9(drizzle-kit)は本 spec で
   決着済み、A-11〜A-13(deep import / 大型ファイル / evals tsconfig)は新規登録済みでトリガー
   未成立。台帳 B(4 件、B-4 含む)は再フラグしない。
4. **次の DDL 変更時**: ADR-0002 の再トリガー条件(テーブル追加/変更を伴う機能 spec、複数環境への
   バージョン管理された migration 要件)に当たるかを確認し、当たる場合のみ drizzle-kit 採用を
   再検討する。
5. **`services/agent/pyproject.toml` の `pythonpath = ["."]` を変更する際**は、ローカル shell の
   `PYTHONPATH` 環境変数汚染がテスト結果を隠しうることを踏まえ、`env -u PYTHONPATH` での再現を
   セットで行う。
