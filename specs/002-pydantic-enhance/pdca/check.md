# Check Phase — 002-pydantic-enhance（Phase A）

PDCA Check: Do フェーズの実装結果を、Phase A（本線 TS 強化 / Req 1）の期待に照合する。
`/sdd-reflect` により生成（`pdca/plan.md` 不在のため、期待値は `plan.md` の File Structure Plan・
`tasks.md` Task 1–3・`spec.md` Req 1.1–1.8 を正本として抽出）。

## Expectations vs. Results

| Expectation (from plan / tasks) | Result (from do) | Status |
|-------------------------------|------------------|--------|
| Req 1.1 `CHAT_SYSTEM_PROMPT`（role/tone・tool-usage・`[source#ordinal]`・権威側宣言）を定数化 | `prompt.ts` に追加、既存 `RETRIEVED_CONTEXT_BEGIN/_END`・`UNTRUSTED_NOTICE` を再利用しハードコード重複回避（5 テスト） | ✅ |
| Req 1.2 `buildStreamTextOptions` が `system` を渡し、内容 + built options 存在をテスト | `system: CHAT_SYSTEM_PROMPT` 配線、内容検証 + 全キー存在検証（Task 2.4/2.6） | ✅ |
| Req 1.3 `stopWhen` = `isStepCount(MAX_STEPS)` + 累積トークン予算、閾値は Zod env で default 付き検証 | `CHAT_TOKEN_BUDGET`（`z.coerce.number().int().positive().default(200_000)`）+ `stopWhen` 配列化 | ✅ |
| Req 1.4 run 終了時に `{finishReason,usage,steps}` を閉じた `stop_reason` へ写像、telemetry span + `deps.audit` へ記録（raw 本文なし） | `deriveStopReason` 純粋関数 + `onEnd` で span 属性（素 OTel API）+ `recordRun` 配線、R4.7 維持 | ✅ |
| Req 1.5 supervisor が同じ run-metrics 形状を optional `JobEvent` 拡張として emit、Zod 契約更新（ドリフト無し） | 当初は契約（`metrics: …optional()`）のみで supervisor 側の emit 未配線（後述 Issues）。adversarial-review で検出後、`supervisor.ts` の `documentGeneration` 既定スペシャリストに `usage` 集計を追加し、job-level completion に集計済み `metrics`（`stopReason: "natural"` 固定 + トークン合算 + `stepCount`）を配線して修正済み | ✅（修正後） |
| Req 1.6 3 停止経路（budget / step-cap / natural）を `MockLanguageModelV4` 単体で網羅 | `chat-agent.spec.ts` に end-to-end 3 経路 + `stop-reason.spec.ts` 13 決定論テスト | ✅ |
| Req 1.7 `docs/context-budget.md` に現行方針 + 段階的 compaction、`prepareStep` に未設定時 byte 等価の窓化シーム | `windowMessages?` シーム（byte 等価）+ `docs/context-budget.md` 作成 | ✅ |
| Req 1.8 system プロンプトで tier1/tier3 verdict が変われば before/after nightly 記録 | Phase A スコープ外。Task 9（Req 5 還流ループ初回行使）へ明示委譲 | ⏸ 委譲 |

## Test & Quality Outcomes

- Tests: `mise run test:run` 最終 **48 files / 465 tests passed**（Phase A で 415 → 465、+50、既存回帰ゼロ。
  464 は本 Check 生成直後の値、+1 は下記 Req 1.5 修正で追加した supervisor 統合テスト）。
- Lint: `mise run lint` → `Checked 127 files. No fixes applied.`（数回 `lint:fix` で自動整形後にクリーン）。
- Type check: `mise run typecheck` → 全 8 ワークスペース green（`@vaz/agents` は消費側 `apps/web`/`apps/worker` 経由で推移的検査）。
- Audit / model-id gate: `audit` → No known vulnerabilities、`lint:model-ids` → ✅ No hardcoded model IDs。
- Build: `next build` は `/_global-error` prerender で失敗したが、`git stash` で本変更なしでも再現 →
  既存の環境問題（ローカル dev の非標準 `NODE_ENV`）と切り分け、`NODE_ENV=production` で正常終了（6 ルート）を確認。**本変更に起因せず**。
- Performance: Phase A に定量目標なし（該当なし）。

## Requirements Coverage

- Covered: Phase A スコープ **7/7（100%）**（Req 1.1–1.7、Req 1.5 は adversarial-review 起因の修正込み）。
- Deferred: Req 1.8（nightly before/after）は設計上 Task 9 の還流ループ初回行使に委譲（Phase A の受入基準は充足）。
- Gaps: 修正済み（下記 Issues 参照）。本 Check の初版時点では Req 1.5 が契約のみで未配線だった。

## Deviations from Design

- **Task 2.2 と 2.3 を同一セッションで着地**: 2.2（`deriveStopReason` 実装）は 2.3 の先行失敗テストを前提とする
  Red-Green 構造のため、テストと実装を分離せず合わせて着地。tasks.md のテスト規約に整合、逸脱ではなく TDD の自然な結合。
- **`@opentelemetry/api` を直接依存へ昇格**: 「run 終了後に span 属性を事後付与」する要件（Req 1.4）を、既存の
  `enrichSpan`/`runtimeContext`（span 生成時のみ評価）では満たせず、素の `trace.getActiveSpan()?.setAttributes()` が必要。
  `ai`/`@ai-sdk/otel` の推移的依存として既にロック済み（`1.9.1`、install script 無し）を **直接宣言に昇格**（新規解決なし）。
- **span 属性付与を try/catch で fail-soft 化**: `initTelemetry` の既存パターン（NFR-4）に合わせ、テレメトリ失敗が run を壊さない設計を追加。

## Issues Encountered

| Issue | Root cause | Resolution |
|-------|-----------|------------|
| Req 1.5「supervisor SHALL emit run-metrics」が未配線（`/adversarial-review` HIGH 指摘） | Task 1.4 で `JobEvent.completion.metrics` という **契約**（optional field）は追加したが、`supervisor.ts` 側で実際に値を計算・添付する配線が漏れていた。`do.md`/本 check.md 初版はこれを ✅ と誤記録していた | `run-metrics.ts` に `runUsageSchema`（3 トークン項目）を切り出し `runMetricsSchema`/`document-generation` specialist result の両方から再利用。`supervisor.ts` の既定 `documentGeneration` specialist が `generateText` の `usage` を結果に含め、`dispatch` が全 document-generation ステップの usage を合算 + `stepCount = plan.steps.length` + `stopReason: "natural"`（supervisor は budget/step-cap 概念を持たず、失敗時は completion に到達しないため固定で正しい）で job-level completion に `metrics` を配線。統合テスト（2 ステップの usage 合算検証）を追加 |
| `next build` が `/_global-error` prerender で `useContext` null | ローカル dev の非標準 `NODE_ENV`（`global-error.tsx` コメント既知） | `git stash` で本変更外と切り分け → `NODE_ENV=production` で正常終了を確認 |
| env 新フィールドが空文字→default にフォールバックしない不整合の懸念 | `env.ts` は「スキーマ定義」と「`emptyToUndefined` 経由の build object」の二箇所更新が必須 | 両方を同時更新、テスト 3 番目のケース（空文字→unset→default）で固定 |
| 「telemetry span 属性に記録」を満たす既存機構が事後付与不可 | `enrichSpan` は span 生成時点でしか評価されない | 素 OTel API を直接依存昇格で導入（上記 Deviation 参照） |

**確認済みで false positive と判定した指摘**: 同レビューで「`onEnd` の `event.steps.length` が 0 になり得て `runMetricsSchema.stepCount`（`.positive()`）と不整合」という MEDIUM 指摘も出たが、`ai@7.0.14` の実装（`node_modules/.pnpm/ai@7.0.14_*/dist/index.js`）を確認した結果、`onEnd` は `lastStep = steps.at(-1)` を無条件に参照してイベントを組み立てるため、`steps.length === 0` の場合はイベント構築時に例外が発生し `onEnd` 自体が呼ばれない — つまり `onEnd` が実際に呼ばれる時点で `steps.length >= 1` は SDK 側で保証されている。修正不要と判断し `stepCount: .positive()` は現状維持。

## Assessment

Phase A は初版 Check（`do.md` を正本とした照合）では Req 1.5 を過大評価していた ——
`JobEvent` の契約拡張のみで supervisor 側の実配線が漏れており、`/adversarial-review` の
フレッシュコンテキストでの再照合で HIGH 指摘として検出された。修正後は Req 1.1–1.7 を
実質 100% カバーし、既存 465 テストで回帰ゼロ、lint/typecheck/audit/model-id ゲート全緑。
設計逸脱は 3 件とも要件充足のための正当かつ低リスクな判断（TDD 結合 / 推移的依存の直接宣言 /
fail-soft）で、いずれも do.md に根拠を記録済み。唯一のビルド失敗は本変更に起因しない既存
環境問題と切り分け済み。**M1 到達、Phase A は本番投入可能な品質（Req 1.5 修正込み）**。
Req 1.8 の nightly before/after のみ Task 9 へ委譲（Phase A 受入基準は充足済み）。
