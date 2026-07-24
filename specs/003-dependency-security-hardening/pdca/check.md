# Check Phase — 003-dependency-security-hardening

PDCA Check: 実装結果(Do)を計画時の期待(Plan/Spec/Tasks)と突き合わせる。
散文は日本語、識別子・パス・コードは英語(`spec.json` `language: ja`)。
本 Check は `pdca/do.md`(Task 2–8)と、リポジトリ実体の再確認(2026-07-24 時点)に基づく。

## Expectations vs. Results

| Expectation (from plan/spec) | Result (from do + 実体確認) | Status |
|-------------------------------|------------------------------|--------|
| R1.1/1.2 止血追認: `next`≥16.2.11 / `next-auth`=beta.32、`pnpm audit` 0 件、override に GHSA・撤去条件コメント | `pnpm-workspace.yaml` に `sharp@<0.35.0`/`js-yaml`/`brace-expansion` の 3 override + GHSA コメント確認。`audit` No known vulnerabilities | ✅ |
| R1.3–1.5/2.3–2.4 runbook 新設 + `AGENTS.md` リンク | `docs/dependency-policy.md`(138 行)新設、4 段階選択基準・撤去条件表・`ignoreGhsas` 書式例・Renovate 採否基準を収録 | ✅ |
| R2.1/2.2 audit 独立ジョブ + 集約 `gate` を required check に新規作成 | `tests.yml` に `unit`/`audit`/`e2e`(並列独立)+ `gate`(`needs:[unit,audit,e2e]`, `if: always()`)を確認。PR #4 で `gate` green を実観測 | ⚠️(gate 実装・実走は完了。branch protection 新規作成は**運用者へ申し送り**) |
| R3.1–3.3 `NODE_ENV` build quirk 恒久対処 | `mise.toml` build に `NODE_ENV=production` 前置、`tests.yml` e2e Build step に env 追加、`global-error.tsx` NOTE 更新。RED/GREEN(未設定・development 両シェルで build 成功)を実測 | ✅ |
| R4.1/4.2/4.3 Python 小粒ハードニング + 002 spec 追記 | `routes/eval.py` 2 箇所 `RuntimeError` 化、`llama.py` `to_token_usage` を provider-reported total 透過へ、002 `spec.md` に Req 2.7b 所管注記追加。`py:check` 61 pass | ✅ |
| R5.1/5.2/5.3 002 運用確認 3 件の完了 | 5.1/5.3 は `ANTHROPIC_API_KEY` 未設定により閾値判定コードへ到達不能(=観測不能として記録)。5.2 M3 E2E は実行したが fail(002 由来の 2 原因) | ⚠️(すべて「実施・記録」は完了。観測結果は運用者アクション待ち) |
| R6.1/6.2/6.3 追加防御ハードニング(self-review) | `prompt.ts` `escapeDelimiters`、`pr-gate.ts` `isPrGateRunSample`+`console.warn` 4 経路分離、`llama.py` `resolve_judge_llm` `RuntimeError` 化を確認。vitest 48 / py:check 61 green | ✅ |

## Test & Quality Outcomes

- Unit: `mise run check` の `test:run` は最終 **572 passed**(止血時 559 → 追加ハードニングの新規ケース分増)。
- Lint / type / model-ids: biome green、tsc(web/worker/evals)Done、`lint:model-ids` no hardcoded IDs。
- Python: `mise run py:check`(uv sync + ruff + pyright strict + pytest)**61 passed**、pyright 0 errors。
- Build: `NODE_ENV` 未設定・`development` 両シェルから `mise run build` が全ルート prerender 成功(件数は出力で確認・固定値は埋め込まない)。
- CI 実走: PR #4 で `unit`/`audit`/`e2e`/`gate` すべて pass(`gate` の初回実走を実観測)。

## Requirements Coverage

- 全 AC 数: R1(5)+R2(4)+R3(3)+R4(3)+R5(3)+R6(3) = **21**。
- Covered(実装・検証完了): 1.1–1.5, 2.1, 2.3, 2.4, 3.1–3.3, 4.1–4.3, 6.1–6.3 = **17/21**。
- Partial(4/21 — 実施・記録は完了、外部アクション待ち): **2.2**(branch protection の新規作成は運用者へ)、**5.1/5.3**(`ANTHROPIC_API_KEY` 未設定でゲート実行前 skip → 観測不能として記録)、**5.2**(実行済み・fail・原因の当たりまで記録、修正は 002 スコープ)。
- Gaps(未実施): なし。すべての AC は本 spec のスコープ内で着地、または明示的な申し送りとして記録済み。

## Deviations from Design

- **Task 5.2 の前提反証(最重要)**: plan/tasks は「`RunUsage.total_tokens` は cache/reasoning を含み `input+output` と一致しない場合がある」を前提に非 0 cache テストを指示。実装前に pin 版 `pydantic-ai` 2.13.0 のソースを直読した結果、`total_tokens` は常に `input+output` を返し、かつ `input_tokens` が cache トークンを既に含む契約と判明 → 実在 `RunUsage` では分岐不能。検証意図(「再計算せず透過する」契約)を保つため、`total_tokens` のみを override するテストダブル `_DivergingTotalUsage` に置換した。
- **Task 3 の branch protection**: plan の fallback どおり、`gate` が CI 上で一度も走っていない段階での required-check 指定は保留し、PR #4 で `gate` を実走させてから運用者が作成する順序をユーザー承認のもと採用。PR 本文に `gh api ... PUT` 手順を転記。
- **`auditConfig.ignoreGhsas`**: 設計どおり**空のまま導入せず**、runbook に書式のみ記載(現時点で必要な advisory がないため)。

## Issues Encountered

| Issue | Root cause | Resolution |
|-------|-----------|------------|
| 5.1/5.3 の閾値判定を観測できない | リポジトリ Secrets に `ANTHROPIC_API_KEY` 未設定 → `eval-pr.yml`/`eval-nightly.yml` がゲート前段で skip | 「観測不能」として記録し完了。secret 追加後の次回 PR/nightly で再観測を 002 側へ申し送り |
| M3 locator E2E が fail | (1) 既存テストの `getByText("You")` 曖昧一致バグ、(2) 合成 PDF の実 Docling/OCR 経路での末尾文字 `19.` 欠落 | 両者とも 002 由来・本 spec スコープ外につきコード修正せず、原因の当たりまで記録して 002 へ申し送り |
| Task 5.2 のテストが計画どおり書けない | サードパーティの**振る舞い前提**が誤り(型の存在は gap-analysis で確認済みだがセマンティクスは未確認) | ソース直読で反証 → 契約本質を突くテストダブルへ設計変更 |

## Assessment

本 spec はコード変更を意図的に小さく保った運用・防御ハードニング spec であり、**スコープ内の全 AC が着地**した。品質ゲート(`check` 572 / `py:check` 61 / build)はすべて green、CI 上で `gate` の初回実走も確認済みで、実装品質としては production-ready。

残る 3 点(branch protection 新規作成、`ANTHROPIC_API_KEY` 追加後の閾値判定観測、M3 E2E の 002 側修正)はいずれも**本 spec の実装欠陥ではなく、運用者アクションまたは別 spec 所管**であり、明示的な申し送りとして記録済み。over-claim を避けるため、これらを「完了」ではなく「実施・記録済み/外部待ち」と区別して扱う。
