# 004-debt-closeout-refactor — Implementation Gap Analysis

散文は日本語、識別子・型・パス・コードは英語(`spec.json` `language: ja`)。
**判断ではなく情報と選択肢**を提供する。

> 状態: 本 feature は棚卸し(2026-07-24)の検証結果を起点に起票された。gap-analysis の
> 主目的は「要件⇔現状コードの突合」だが、本 spec は棚卸しそのものが突合であったため、
> 本書は突合結果の確定記録を兼ねる。**spec 起票時点で既に ✅ の AC が複数ある**こと
> (R4.1、model-ID ゲートの `*.py` 走査)が本 spec の特徴で、それ自体が「ドキュメントが
> 現実より悲観的だった」という発見である。

## Analysis Summary

- **R2(`@vaz/db` 分割)が唯一の構造変更**。事前検証で絡まりは低いと確定済み:
  `@vaz/rag/db/schema` の本番 import は `apps/worker/src/stores.ts` の 1 箇所、web は
  `@vaz/worker` ポート層で絶縁、tsconfig `paths`・`transpilePackages` 等の別解決経路は無し
  (pnpm workspace + `exports` map のみ)→ 移動は機械的。
- **R4 は実装不要と判明**: `email.ts:111` が配送前に `assertAllowedRecipient` を呼び、
  `email.spec.ts` が allow/reject 両経路をカバー。残る債務は `allowlist.ts` docstring の
  stale 文言のみ。
- **R5 の欠落は実在**: `lint.yml` は biome+tsc のみ、pre-commit は 4 ステップ
  (model-ids 無し)、`py:check` を走らせる workflow ゼロ、coverage 除外は `nightly.ts` のみで
  同型 CLI の `pr-gate.ts` が非対称。
- **R6 の 2 原因はコードで確認**: `getByText("You")` は 3 spec に存在(`Chat.tsx` の
  role ラベル `<strong>You</strong>` が exact 一致対象)、`DISTINCTIVE_FACT` は codename が
  行末に位置(OCR 行末欠落の直撃点)。
- **推奨アプローチは Extend(既存パターン踏襲)**: source-only package 慣例、workflow の
  mise-action 様式、coverage 除外コメント様式、compose の committed-decision 様式に完全に載る。

## Per-Requirement Gap Table

凡例: ✅ 既存コードで充足 / 🔧 一部存在(拡張要) / 🆕 新規構築 / 👁 観測・記録のみ

### Requirement 1 — 保留項目台帳

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 1.1 | 🆕 | 003 の棚卸しは pdca 内記録に留まる。spec 本文の台帳は新規。 |
| 1.2 | 🆕 | 意図的設計の検証記録(supervisor.ts docstring / stores.ts サーフェス / allowlist ガバナンス)は各所に散在、集約は新規。 |
| 1.3 | 👁 | 運用者アクション 3 件は 003 act.md 記載済み。現況の再確認と台帳への転記のみ。 |

### Requirement 2 — `@vaz/db` 分割

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 2.1 | 🆕 | `packages/db` は存在しない。schema.ts(207 行)・`drizzle/0000_add_locator.sql`・`tests/schema.spec.ts` の 3 ファイル移動 + package.json 新設。 |
| 2.2 | ✅→🔧 | schema.ts は既に runtime で `@vaz/*` を import しない(docstring 明記「Not imported here to keep this table module free of runtime `@vaz/schemas` coupling」)。パッケージ境界化のみが新規。 |
| 2.3 | 🔧 | import 書換 16 コードファイル(grep 確定): rag src 2 / rag tests 5 / worker src+test 2 / evals unit 2 / agents tests 2 + コメント・README 参照。 |
| 2.4 | 🔧 | `drizzle-zod` は rag で schema.ts のみが利用(grep 確定)→ 除去可。worker の rag import は stores.ts のみ(grep 確定)→ 置換可。 |
| 2.5 | 👁 | 挙動変更ゼロの検証はゲート実行(vitest 573 / coverage / audit)。 |
| 2.6 | 🔧 | AGENTS.md L111(dep graph)/ L146(future refactor)/ 構成図、CLAUDE.md L25(six packages)。 |

### Requirement 3 — ドキュメント整合

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 3.1 | 🔧 | AGENTS.md L92-104「Active Spec: 002」: 「system prompt を currently does NOT pass」は 002 Phase A で解消済み(`prompt.ts` の `CHAT_SYSTEM_PROMPT` 実在)。「NFR-2 will be extended」は実装済み(下記 3.2)。 |
| 3.2 | ✅(コード)/ 🔧(文言) | `scripts/forbid-model-ids.sh:35` `--include='*.py'`、`:43` config.py カーブアウト — **NFR-2 は実装済み**。AGENTS.md の記述だけが古い。 |
| 3.3 | 🆕 | 002 act-final.md Learnings→Rules 表の 4 候補は AGENTS.md 未反映(act-final 自身が「次の steering 更新で取り込む」と申し送り)。 |
| 3.4 | 🔧 | CLAUDE.md は `@AGENTS.md` inline のため固有文(パッケージ数・dep graph)のみ。 |

### Requirement 4 — R5.4 配線の追認

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 4.1 | ✅ | `packages/tools/src/email.ts:111` `assertAllowedRecipient(input.to, allowlist)`(配送トランスポート前)。`packages/tools/tests/email.spec.ts` に allow / `RecipientNotAllowedError` reject 両テスト。**実装ギャップなし** — 棚卸しの主要発見。 |
| 4.2 | 🔧 | `allowlist.ts:12-19` docstring「wiring … is deferred to the task that owns that file's edit boundary」が stale。 |

### Requirement 5 — CI ゲート配線

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 5.1 | 🆕 | `lint.yml` は biome(`:28`)+ typecheck(`:31`)のみ。 |
| 5.2 | 🔧 | pre-commit は 4 ステップ。ヘッダに「enforced by `mise run check`」の stale 文言。 |
| 5.3 | 🆕 | `py:check` を走らせる workflow ゼロ(lint/tests/eval-nightly/eval-pr の 4 本を確認)。`mise.toml` `[tools]` に uv 無し。 |
| 5.4 | 🔧 | `vitest.config.ts:52` は `nightly.ts` のみ除外。`pr-gate.ts` は同型 CLI(`import.meta` ガード付き `main()`)なのに非対称。 |

### Requirement 6 — M3 locator E2E

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 6.1 | 🔧 | `getByText("You")` 3 箇所(locator-citation:171 / chat-ollama:54 / chat-anthropic:31)。`Chat.tsx:62` の `<strong>You</strong>` が exact 一致の対象。 |
| 6.2 | 🔧 | `DISTINCTIVE_FACT` は `…is ${CODENAME}.` で codename が行末 — OCR 行末欠落(003 記録の `19.` 喪失)の直撃配置。 |
| 6.3 | 👁 | 実走は環境依存([E] 節)。実装環境に docker/Ollama 無し → honest-skip 予定。 |

### Requirement 7 — sidecar compose profile(任意)

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 7.1 | 🆕 | `services/agent` に Dockerfile 無し・compose サービス無し(リポジトリ唯一の Dockerfile は `apps/worker/Dockerfile`)。 |
| 7.2 | 👁 | bare-metal 起動手順は e2e spec のエラーメッセージ・README に既記。 |

## Options Considered(要点)

- **R2 カット線**: (A) schema 全体移動【推奨・採用】 / (B) workflow テーブルのみ —
  B は rag の blast radius ゼロだが `EMBEDDING_DIM`・contract の所有が 2 分裂し、
  「スキーマの正本はどこか」の答えが複雑化する。
- **R5.4 coverage**: (A) 単純 exclude【推奨・採用】 / (B) pure 関数抽出 + CLI のみ除外 —
  B が綺麗だが diff 増。nightly.ts の既存判例と対称な A を採る。
- **python.yml の位置づけ**: (A) 独立 workflow・non-required【推奨・採用】 / (B) `gate` 包含 —
  B は path-filter との相性問題(不存在ジョブの needs 集約)で即却下、または filter 撤廃で
  全 push に Python provisioning コストを課すことになる。
