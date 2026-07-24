# 004-debt-closeout-refactor — Act(申し送り・学び)

日付: 2026-07-24。

## Outcome

- 保留リストを **ゼロベース化**: 記録上「保留」だった項目のうち、実態解消済み 4 件
  (docstring/steering 乖離)を是正、着手可能な実債務 3 領域(`@vaz/db` 分割 / CI ゲート /
  M3 E2E)を消化、残る全項目を検証済みトリガー付き台帳(spec.md)として確定。
- 001 Phase 3 から 3 spec 繰延の `@vaz/db` 分割を挙動変更ゼロで完了(573 tests green、
  coverage 88.56%/87.38%)。
- 宣言のみだった 2 ゲート(`lint:model-ids` / `py:check`)を自動トリガーへ配線。

## Learnings → Rules Mapping

| Learning | Candidate rule / steering update |
|---|---|
| 「保留」記録は腐る — 002 NFR-2(model-ids の `*.py` 拡張)と R5.4 配線は実装済みなのに docs/docstring が「未了」を主張し続け、003 の 46 項目棚卸しでも検出されなかった(ドキュメント同士の突合だったため) | 棚卸しは **spec 記録 ⇔ コード実態の突合**を必須とする。「保留」を書いた場所(docstring/AGENTS.md)は、解消コミットの `_Boundary:_` に含める(解消と同時に文言を消す) |
| 「define now, wire later」パターンは配線完了時に定義側 docstring の更新を忘れやすい(allowlist.ts が好例) | wire する task の `_Boundary:_` に定義側ファイルを含める(002 レトロの「周辺必須ファイル先回り」の具体例として追加) |
| ゲートの宣言(mise task 化)と執行(自動トリガー配線)は別物 — `lint:model-ids` は 001 から存在したが、どの push でも走っていなかった | 新ゲート導入 AC には「どの自動トリガーで走るか」を必須項目にする |
| path-filter 付き CI ジョブと required-check 集約(`needs` + `if: always()`)は両立しない | required 化したいジョブに path-filter を付けない / 付けるなら `gate` 外の可視化専用と割り切る(python.yml で採用) |

## Next Actions(申し送り)

1. **M3 locator E2E の実スタック実走 1 回**(6.3 の委譲先): ローカルで
   `docker compose --profile sidecar up -d` + Ollama(`nomic-embed-text` + chat モデル)+
   `DATABASE_URL`/`AGENT_SERVICE_URL` を設定し `mise run test:e2e:ollama`。green なら 002
   act-final の M3 PENDING を最終クローズ。sidecar イメージの初回ビルド確認
   (`/healthz` probe)を兼ねる。
2. **python.yml の初回発火観測**: 本ブランチ push は `services/agent/**`(Dockerfile)に触れる
   ため path-filter が発火する見込み。`mise run py:check` が CI runner(uv provisioning 込み)で
   green になることを 1 度確認。fail の場合は mise-action の uv 解決を確認(`[tools] uv = "0.9"`)。
3. **運用者アクション 3 件は台帳 C のまま継続**(コード外): `ANTHROPIC_API_KEY` Secret →
   eval-pr/nightly 初観測、branch protection 新規作成(`gate` green 後)、sharp/postcss
   override 撤去監視。
4. **次の DDL 変更時**: drizzle-kit 採用判断(台帳 A-9)。migration の置き場所は
   `packages/db/drizzle/` に確定済み。
5. **次回棚卸し時**: 台帳 B(意図的設計 3 件)は再フラグしない。台帳 A のトリガー成立チェック
   から始める。
