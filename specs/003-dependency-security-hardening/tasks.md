# 003-dependency-security-hardening — Implementation Tasks

`plan.md` に準拠。散文は日本語、識別子・型・パス・コードは英語。

規約(002 と同一):

- `- [ ]` 未着手 / `- [x]` 完了 / `- [ ]*` 任意・後回し可。
- `(P)` = 並列実行安全(依存なし・境界が互いに素)。
- 全タスクは `_Boundary:_` と `_Depends:_` を宣言する。
- `_Requirements:_` は要件 ID のみをカンマ区切りで列挙する。

## Task 依存図

```
Task 1(止血・実施済み)
Task 2(runbook)──→ Task 3(CI ジョブ分離)   ※ 3 は 2 の選択基準を参照するため後行が望ましい
Task 4(NODE_ENV)(P)
Task 5(Python ハードニング)(P)
Task 6(002 spec 追記)(P)
Task 7(運用確認)── 本 spec の PR / ローカルスタックで実施
```

---

## 1. 依存 advisory 止血(実施済みの追認)

2026-07-24 実施。`next` 16.2.11 / `next-auth` 5.0.0-beta.32 へバンプ、`sharp` / `js-yaml` /
`brace-expansion` を GHSA・撤去条件コメント付き overrides で修正版へ強制。
`pnpm audit` 0 件、biome + tsc + vitest(559 pass)+ `NODE_ENV=production next build` green を確認。

_Boundary:_ `apps/web/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
_Depends:_ none
_Requirements:_ 1.1, 1.2

- [x] 1.1 `next` / `next-auth` の直接依存バンプと lockfile 更新
- [x] 1.2 `sharp@<0.35.0` / `js-yaml@>=4.0.0 <4.3.0` / `brace-expansion@>=2.0.0 <2.1.2` の
  overrides 追加(各 GHSA ID・理由・撤去条件コメント付き)

## 2. advisory 対応 runbook の新設

_Boundary:_ `docs/dependency-policy.md`, `AGENTS.md`
_Depends:_ Task 1(実例として参照)
_Requirements:_ 1.3, 1.4, 1.5, 2.3, 2.4, NFR-2

- [ ] 2.1 `docs/dependency-policy.md` を新設: 検知 → `pnpm audit --json` 棚卸し → 対応 4 段階
  (直接バンプ / lockfile 更新 / override / ignoreGhsas)の選択基準 → 検証手順 →
  `minimumReleaseAge`/`minimumReleaseAgeExclude` との関係。
- [ ] 2.2 同文書に override / ignoreGhsas の撤去条件表を置く(初期エントリ: `sharp` は
  next stable が 0.35 系依存へ更新された時点で撤去、ほか 2 件は upstream 範囲更新で自然解消後)。
  ignoreGhsas の書式例((a) 内容 (b) 除外理由 (c) 再評価期限)を含める。
- [ ] 2.3 (P) Renovate/Dependabot の採否基準を記録する(`minimumReleaseAge`・`allowBuilds` との
  整合条件。導入自体は out of scope)。
- [ ] 2.4 `AGENTS.md` の「Supply chain gate」項から `docs/dependency-policy.md` へのリンクを追記。

## 3. Security Audit の独立ジョブ化

_Boundary:_ `.github/workflows/tests.yml`
_Depends:_ Task 2(参照のみ・非ブロッキング — runbook の選択基準を README 的に参照する順序の
  推奨であり、NFR-1 の「R2〜R5 は任意順」の例外ではない。Task 2 未着手でも Task 3 は着手可能)
_Requirements:_ 2.1, 2.2, NFR-2

- [ ] 3.1 `unit` ジョブから Security Audit ステップを除去し、独立 `audit` ジョブ
  (checkout → mise-action → pnpm-setup → `pnpm install --frozen-lockfile` →
  `pnpm audit --audit-level=moderate`)を追加する。`unit`/`audit`/`e2e` は並列・独立のまま
  (いずれにも `needs` を付けない — audit 失敗時に unit/e2e の可視性を壊さないため)。
- [ ] 3.2 `needs: [unit, audit, e2e]` かつ `if: always()` の集約 `gate` ジョブを追加し、
  いずれかが `success` 以外なら非 0 終了させる。**前提確認済み**: `main` に branch protection は
  現状存在しない(`gh api repos/:owner/:repo/branches/main/protection` → 404、`rulesets` API も空、
  2026-07-24 確認)。したがって「現行の `unit` 単体から置き換える」のではなく、`gate` を
  required check とする branch protection を**新規作成**する(リポジトリ設定)。新規作成できない
  場合は、PR 説明に運用者向け手順を明記し、作成が完了するまでは **どのジョブもマージを
  ブロックしていない**(既存 required 設定の一時後退ではなく、未設定の継続である)ことを
  明示的に記載する。

## 4. `NODE_ENV` build quirk の恒久対処

_Boundary:_ `mise.toml`, `.github/workflows/tests.yml`, `apps/web/src/app/global-error.tsx`
_Depends:_ none
_Requirements:_ 3.1, 3.2, 3.3

- [ ] 4.1 (P) `mise.toml` `[tasks.build]` に `NODE_ENV=production` を前置する。
- [ ] 4.2 (P) `tests.yml` の e2e `Build` ステップに `env: NODE_ENV: production` を明示する。
- [ ] 4.3 (P) `global-error.tsx` の NOTE を「ビルドパスが `NODE_ENV=production` を強制する」旨へ
  更新する。
- [ ] 4.4 検証: `NODE_ENV` 未設定および `NODE_ENV=development` のシェルから `mise run build` が
  全ルートを prerender して成功することを確認する(件数はビルド出力で確認し、固定件数を
  検証記述に埋め込まない)。

## 5. Python サイドカーの小粒ハードニング

_Boundary:_ `services/agent/app/routes/eval.py`, `services/agent/app/eval/llama.py`, `services/agent/tests/`
_Depends:_ none
_Requirements:_ 4.1, 4.2, NFR-3

- [ ] 5.1 (P) `routes/eval.py` の bare `assert`(2 箇所)を `RuntimeError` 送出へ置換する
  (pyright strict の narrowing を保つためローカル変数化)。既存テスト green を維持。
  `judge.last_usage is None` となる経路(judge を usage 未記録スタブに置換)を強制する
  テストを追加し、`AssertionError` ではなく `RuntimeError` が送出されることを検証する
  (`python -O` での `assert` 無効化そのものは pytest 実行では再現不能なため検証対象外——
  この置換の目的は「`-O` 下でも検査が残る」ことであり、テストは型変更後の例外種別と
  到達可能性を確認する)。
- [ ] 5.2 (P) `to_token_usage` を `RunUsage.total_tokens`(provider-reported)採用へ変更する
  (存在は gap-analysis で検証済み・確定)。docstring に境界定義
  (total は cache/reasoning トークンを含み得るため input+output と一致しない場合がある)を
  明記し、`services/agent/tests/` の期待値が `input+output` 前提の箇所を実測値に追随させる。
  既存の `test_llama.py::test_to_token_usage_sums_input_and_output`
  (`total_tokens == input_tokens + output_tokens` を assert)は cache=0 の `TestModel` では
  変更後も偶然 green のままになり得るため、境界定義そのものを検証しない。
  `cache_read_tokens`/`cache_write_tokens` が非 0 の `RunUsage` を与え
  `total_tokens != input_tokens + output_tokens` となるケースを追加テストで検証し、
  既存テストは提供元 total をそのまま透過することを検証する意図に沿って命名・docstring を
  更新する。
- [ ] 5.3 `mise run py:check` green を確認する。

## 6. 002 spec への Req 2.7b 所管の明文化

_Boundary:_ `specs/002-pydantic-enhance/spec.md`
_Depends:_ none
_Requirements:_ 4.3

- [ ] 6.1 (P) 002 `spec.md` Requirement 2 に「Req 2.7b の `traced_span` 配線は Phase E 所管
  (相関 ID `case_id`/`job_id` は呼び出し側 = nightly runner の持ち物)」の注記を追記する
  (既存の判定履歴は改変しない)。

## 7. 002 の運用上の未実施確認

_Boundary:_ `specs/003-dependency-security-hardening/pdca/`(記録のみ)
_Depends:_ Task 1(PR が観測機会)
_Requirements:_ 5.1, 5.2, 5.3

- [ ] 7.1 本 spec の PR で `eval-pr.yml` が閾値ブロック判定へ遷移することを観測・記録する
  (002 Req 5.4 初回観測)。
- [ ] 7.2 ローカルスタック(docker compose + Ollama)で `mise run test:e2e:ollama` を実行し、
  M3 locator 引用 E2E の結果を記録する。
- [ ] 7.3* 依存バンプ後の nightly eval で tier1/tier3 verdict 変化があれば before/after を記録する
  (変化がなければその旨を記録して完了)。
