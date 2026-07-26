# Act Phase — 002-pydantic-enhance（Phase A）

PDCA Act: 実装結果の学びを再利用可能なパターン／予防策へ形式化する。`/sdd-reflect` により生成。

## Check Phase Summary

Phase A（本線 TS 強化 / Req 1）は Req 1.1–1.7 を 100% カバーして計画どおり完全達成 —— ただし、初版の
Check（`do.md` を正本とした自己照合）は Req 1.5（supervisor の run-metrics emit）を誤って ✅ 判定していた。
`/adversarial-review` をフレッシュコンテキストで実行し、`supervisor.ts`/`apps/worker` を実際に grep したところ
`JobEvent.completion.metrics` という **契約**（Zod optional field）は追加済みだが、supervisor 側で実際に値を
計算・添付する配線が一切無いことが判明（HIGH 指摘）。本セッション内で配線を追加し修正済み。既存 465 テストで
回帰ゼロ、lint/typecheck/audit/model-id ゲート全緑。唯一のビルド失敗は本変更外の既存環境問題と切り分け済み。
Req 1.8 の nightly 比較のみ Task 9 へ委譲。

## Outcome

**Success（自己照合の 1 件の過大評価を adversarial-review で検出・修正済み）**

## Success Pattern OR Mistake Record

### Pattern — フック外・純粋関数によるオブザーバビリティ導出（hook-free pure derivation seam）

- **Problem**: SDK のストリーミング/ライフサイクルフック（`onEnd` など）の中に「停止理由の写像」や
  「メトリクス集計」といった導出ロジックを直書きすると、実 LLM ストリームを回さないと検証できず、
  分岐網羅（優先順・境界値）の決定論テストが書けない。フック内の副作用（span 付与・監査記録）と
  純粋な判定ロジックが密結合し、回帰の原因切り分けも困難になる。
- **Solution**: 導出を **入力構造だけに依存する純粋関数**（`deriveStopReason({finishReason, totalUsage, steps, budget, maxSteps})`）
  として切り出し、優先順（`error`→`budget-exceeded`→`step-cap`→`natural`）を早期 return で直線化。
  フック（`onEnd`）側は「純粋関数を呼ぶ → 結果を span 属性 + `deps.audit.recordRun` へ流す」だけの
  薄い配線に留め、テレメトリ失敗は try/catch で fail-soft 化する。入力型は使用フィールドのみに絞る
  （`Pick<LanguageModelUsage,…>` + `readonly unknown[]`）ことでテスト構築コストを下げ、呼び出し側の
  完全な結果型と構造的に互換を保つ。
- **Implementation**:
  1. 導出を別ファイルの純粋関数に抽出（`packages/agents/src/stop-reason.ts`）。
  2. 4 経路 + 優先順 + 境界値（閾値ちょうど / 1 手前）を先行失敗テストで固定（`stop-reason.spec.ts`、13 テスト）。
  3. フックは純粋関数の呼び出し + 副作用配線のみ。副作用は fail-soft。
  4. さらに `MockLanguageModelV4` の end-to-end で「実ループ経由でも同じ `stop_reason` が導出される」ことを別途検証（配線の正しさ）。
- **Benefits**: 分岐網羅が決定論で高速。フック内副作用と判定の関心分離により回帰切り分けが容易。
  入力型を絞ることで再利用・移植コストが低い。同型は「トークン集計」「コスト算出」「レイテンシ分類」など
  他のオブザーバビリティ導出へそのまま転用できる。
- **Evidence**: `packages/agents/src/stop-reason.ts`（純粋関数）+ `packages/agents/tests/stop-reason.spec.ts:1`（13 決定論テスト）
  + `packages/agents/tests/chat-agent.spec.ts` の end-to-end 3 経路。最終 `test:run` 48 files / 464 tests green、回帰ゼロ。
- Saved to: `.sdd/patterns/hook-free-pure-derivation-seam.md`

## Learnings → Rules Mapping

| Learning | Candidate rule / steering update |
|----------|----------------------------------|
| 導出ロジックはフック外の純粋関数に切り出し決定論テストで網羅、フックは薄い副作用配線のみ | steering（tech / testing）に「オブザーバビリティ導出は pure-function seam」を追加候補。`hook-free-pure-derivation-seam` パターン参照 |
| `runMetricsSchema` を単一正本化し `deps.ts`（`.extend()`）/`workflows.ts`（`.optional()`）で再利用しドリフト回避 | AGENTS.md「Zod v4」節に「run-metrics 系は `@vaz/schemas/run-metrics` を単一正本に再利用」を明記候補 |
| optional シームは「未設定時 byte 等価」を受入基準にすると後方互換を機械的に保証できる（`windowMessages?`） | 拡張シーム設計の標準規約として steering に「optional 拡張は未設定時 byte 等価を回帰テストで固定」 |
| 「telemetry span へ事後付与」は既存 `enrichSpan`（span 生成時評価）では不可、素 OTel API が必要 | AGENTS.md「Telemetry」節に「run 終了後の属性付与は `trace.getActiveSpan()?.setAttributes()`、fail-soft」を追記候補 |
| 既に解決済みの推移的依存の直接宣言は新規追加と供給網リスクが異なり軽量判断で可 | 供給網ゲート運用メモ（AGENTS.md「Supply chain gate」）に「推移的既解決依存の直接昇格は allowBuilds 監査不要」を補足候補 |
| `env.ts` はスキーマ定義と `emptyToUndefined` build object の二箇所を同時更新しないと空文字→default が崩れる | `env.ts` 冒頭コメント / テストで固定済み。新フィールド追加チェックリスト項目化 |
| `next build` の `/_global-error` prerender 失敗はローカル dev の非標準 `NODE_ENV` 既知問題 | 予防チェックリスト: ビルドゲート失敗時は `git stash` で切り分け → `NODE_ENV=production` で再実行 |
| 「Zod 契約に optional field を追加した」ことと「その値を実際に計算・配線した」ことは別の達成であり、do.md の記述だけを正本にした自己照合はこの差を見逃した | Check/Act フェーズでは requirement ごとに実装ファイルへの grep（例: `grep -rn "metrics\|recordRun" packages/agents/src apps/worker/src`）を必須ステップとして明記する候補。「契約追加」と「値の配線」を別の受入基準行として tasks.md に分けることも次回検討 |

## Process Improvements

- Red-Green が構造的に結合するタスク（実装が先行失敗テストを前提とする 2.2/2.3 型）は、tasks.md 生成時に
  最初から 1 タスクへ束ねるか「同時着地」を明記して、`/sdd-impl` のスコープ指定と実運用の齟齬を減らす。
- ビルドゲート（`next build`）はユニット緑でも環境要因で落ちうる。do.md に切り分け手順（`git stash` + `NODE_ENV=production`）を
  定型化して残したので、次サイクル以降は同手順を最初から適用する。
- `pdca/plan.md` が未生成だったため期待値を spec/plan/tasks から逆算した。次回は `/sdd-impl` 着手前に plan.md を
  生成しておくと Check の照合が機械的になる。
- **`/sdd-reflect` の Check フェーズは `do.md`（自己申告のナラティブ）だけを正本にしてはならない**。今回、
  Req 1.5 の「supervisor SHALL emit」を do.md の記述だけで ✅ と判定し、実際には契約追加のみで配線が
  無いことを見逃した。`/adversarial-review` をフレッシュコンテキストで実行し、実装ファイルへの直接 grep
  （do.md を読まない）で初めて検出できた。次回から Check フェーズ自体に「requirement ごとに実装への
  grep で裏取りする」ステップを組み込む（`/adversarial-review` を待たずに Check 内で self-adversarial に行う）。

## Next Actions

- **Req 1.8（Task 9）**: system プロンプト導入による tier1/tier3 verdict 変化の before/after nightly 記録を、
  Req 5 還流ループの初回行使として実施（Phase A の唯一の残要件）。
- **Task 12.1**: governance 文書（`docs/agentops.md`）は Req 1.4 メトリクス着地後が望ましい旨が tasks.md にあり、
  Phase A で前提が揃ったため着手可能。
- **steering / AGENTS.md 反映**: 上表の候補ルール（pure-derivation seam / byte 等価シーム / OTel 事後付与）を
  次の steering 更新でまとめて取り込む。
- **Phase B 着手**: Phase A は完全独立で着地済み。`services/agent` スキャフォールド（Task 4）へ進行可能。
