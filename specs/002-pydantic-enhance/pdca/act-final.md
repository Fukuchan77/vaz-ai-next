# Act Phase — 002-pydantic-enhance（Final / Phase C・D・E + フィーチャ完了）

PDCA Act: 実装結果の学びを再利用可能なパターン／予防策へ形式化する。
`/sdd-reflect 002-pydantic-enhance` により生成。Phase A は `act.md`、Phase B は
`act-phaseB.md` が担当済み。本 Act はフィーチャ全体のクローズを対象とする。

## Check Phase Summary

Phase C（境界契約 / Req 3）・Phase D（取り込み強化 / Req 4）・Phase E（評価還流・ゲート・
文書 / Req 5,6）が計画どおり着地し、`/sdd-validate-impl` がフィーチャ全体を **GO** と判定。
全 12 タスク `[x]`、TS 551 / Python 57 テスト green、model-id ゲートは `services/**` 拡張込みで
検出ゼロ、golden set 20 件で PR ゲートの閾値ブロック条件を充足。境界の事後補正は Phase D で
継続したが全て scaffold/配線必須・下流無影響で tasks.md へ反映済み。留保は pre-existing 技術
負債（Next.js/sharp CVE・NODE_ENV build quirk、本 spec スコープ外）のみ——merge 前に
Phase C/D/E への独立 `/adversarial-review` を実施し、実欠陥 5 件を検出・修正済み
（下記 Outcome/Next Actions 参照）。

## Outcome

**Success**（全 12 タスク着地・全ゲート green・GO 判定。C/D/E への独立 `/adversarial-review` を
merge 前に実施し、以下 5 件の実欠陥を検出・修正・再検証済み: (1) `checkDocumentMechanically`
の HTML マッチが `<tag>[\s\S]*</tag>` バックトラッキング正規表現で ReDoS 可能（プロンプト
インジェクション文書からの DoS 経路）→ 開閉タグの線形 2 スキャンへ置換、(2) `pr-gate.ts` が
持続的な `case-failed`（インフラの慢性的フレーキーさ）を毎回 PR ブロック要因に含めていた →
baseline で graded だったケースが新規に落ちた場合のみブロックする `hasNewCaseFailure` を
切り出し、(3) `tier2.ts` がスキーマ不整合応答（境界契約ドリフト）を `request-failed`（サービス
到達不可）と区別せず握っていた → `invalid-response` reason を追加、(4) ingest CLI の `/parse`
レスポンスが `as ParsedChunk[]` で無検証キャストされていた（fail-loud 不徹底）→
`parsedChunksSchema`（`@vaz/schemas/agent-service` 新設）で検証、(5) `/parse` の
`use_llamaparse=true`+キー設定時に未実装の LlamaParse へサイレントフォールバックしていた →
`501 Not Implemented` で明示的に拒否。TS 560 / Python 58 テスト green で再検証。）

## Success Pattern OR Mistake Record

### Pattern — 単一正本の言語境界契約と 1 点ドリフトテスト（single-source-boundary-contract-drift）

- **Problem**: 言語境界で同一構造の型を両側に手書きすると必ずドリフトする（Zod↔Pydantic 二重定義）。
  一方、生成物を CI で毎回ビルドする方式は source-only 規約（no build step）・実行時依存ゼロと衝突する。
- **Solution**: 片側を単一正本に固定 → 生成物をコミット（no build step）→ 反対側は生成型に
  `satisfies z.ZodType<Generated>` で構造的 conform する薄い手書き層 → 3 者のズレを 1 テスト
  （2-leg: 文字列完全一致 + JSON Schema 形状比較）で検出。生成物はフォーマッタ対象外にし、手動
  整形しない（「コミット物 == 生成コマンド出力」不変条件の保護）。
- **Implementation**: `openapi:gen`（Pydantic→OpenAPI snapshot→openapi-typescript）、薄い Zod
  `agent-service.ts`、`contract-drift.spec.ts`（codegen の `--check` と同じ node API を再利用）、
  `biome.json` の生成物除外。
- **Benefits**: ドリフトを CI で 1 テスト機械検出。source-only + 実行時依存ゼロを維持。conform を
  コンパイル時に前倒し。
- **Evidence**: `contract-drift.spec.ts` = 1 passed。意図的ドリフト注入で両 leg 独立 fail を実測後
  復元。Phase C 全編で TS 回帰なし（465→483）、`mise run check` 全緑。
- Saved to: `.sdd/patterns/single-source-boundary-contract-drift.md`

### 補助所見（既存パターンの再確認、新規 mistake なし）

- **Phase D — 単一ライター原則の構造的保持**: `--via-parser` は**既存の** `embed`/
  `assertNoProviderMixing`/`upsertDocument` を再利用し、pgvector 書き込み経路を増やさない。
  既定経路は `locator` を単に未セット（キー省略=`undefined`）にするだけで byte 互換。
  「新機能を既存の単一経路に合流させ、書き込み口を増やさない」は `polyglot-sidecar-isolation-seam`
  の HTTP 境界隔離と同じ「口を 1 つに絞る」規律の RAG 版。
- **Phase E — 既存シームへの素通しで新語彙ゼロ**: Task 11 は `DocumentVerificationError.reason:
  RunStopReason = "error"` を既存の duck-typed catch へ渡すだけで Req 5.7（Req 1.4/1.5 の閉じた語彙）を
  充足し、新規 publish/throw を一切書かなかった。`DocumentVerificationInput` を 2 フィールドに
  狭めることで Req 5.6「会話履歴を渡さない」を型で構造保証。**新規 schema を足さず既存シームへ
  合流させる**判断が Phase C/D/E に通底。

## Learnings → Rules Mapping

| Learning | Candidate rule / steering update |
|---|---|
| 言語境界の型は「単一正本 → 生成物コミット → `satisfies` conform → 1 点ドリフトテスト」で固定する。生成物は手で整形せずフォーマッタ対象外に | steering（tech / conventions）に「言語境界契約は `single-source-boundary-contract-drift` パターンで固定」。AGENTS.md は既に generated 除外・`openapi:gen`・薄い Zod を記載済み |
| `satisfies z.ZodType<Generated>` は欠落/型不一致は検出するが余剰フィールドは検出しない。余剰は別 leg（JSON Schema 形状比較）で拾う | 上記パターンの落とし穴として記録済み。将来の boundary スキーマ追加時のレビュー観点 |
| codegen の照合は自作せず、ツールの `--check` が使う node API を直接呼ぶ（オプション既定差の誤検知回避） | contract-drift 系テストの実装指針として test-strategy skill に候補 |
| 新機能は書き込み口を増やさず既存の単一経路（embed+upsert）へ合流させる（単一ライター） | AGENTS.md の RAG 節に既記載。`--via-parser` を具体例として補強候補 |
| 既存の duck-typed catch / closed-vocabulary へ素通しできるなら新規 publish/throw・新語彙を足さない。入力型を最小フィールドに狭めて要件（履歴を渡さない等）を型で構造保証する | steering（structure）に「既存シーム優先・型で不変条件を保証」。supervisor の `DocumentVerificationInput` を例に |
| A/B で 2 回連続して「契約はあるが未配線」を `/adversarial-review` が検出した。reflect 後のフレッシュコンテキスト review は Check のすり抜けを補う独立防衛線として全 Phase に適用すべき | `/sdd-reflect` 後の推奨フロー化候補: 各 Phase 完了時に `/adversarial-review` を必須ステップに |

## Process Improvements

- **フェーズ完了ごとに `/adversarial-review` を回す**: Phase A（Req 1.5）・Phase B（Req 2.7b）は
  いずれも reflect 直後のフレッシュコンテキスト review が Check のすり抜けた実欠陥を検出した。
  Phase C/D/E では未実施で、ship-gate + validate-impl は緑だが独立検証の網が掛かっていない。
  次サイクル以降は「Phase 完了 → `/sdd-reflect` → `/adversarial-review`（producer/caller 双方への
  grep）」を定型フローにする。
- **`_Boundary:_` に周辺必須ファイルを先回りで含める（Phase B の申し送りを再確認）**: Phase D でも
  `config.py`/`main.py` router 配線/`uv.lock`/TDD テストファイルの事後補正が発生。tasks 生成時に
  「新規エンドポイント追加で必ず触る周辺ファイル（router 登録・別タスク境界の設定拡張・lockfile・
  専用テストファイル）」を各 Task 境界へ予め含める。予告（YAGNI で後回し）があること自体は境界
  更新の免除にならない。
- **conform ガード・ドリフトテストは「注入して落ちること」を実測する**: 宣言しただけで終わらせず、
  意図的にドリフト（型変更・stray 追記）を注入して fail を確認してから復元する 3 段裏取りを標準化
  （Task 6.4/6.5 で実践、Task 11 の機械チェックでも同様）。

## Next Actions

- ~~**（優先）Phase C/D/E に `/adversarial-review` を merge 前実施**~~ — **完了**。上記
  Outcome の 5 件を検出・修正。(a) `--via-parser` の fail-loud 経路は到達確認済み（`parsedChunksSchema`
  検証を追加、無検証キャストの実欠陥を修正）。(b)(c) は独立検証で新規欠陥なしと確認したが、
  代わりに tier2/PR ゲートの skip 条件そのものに設計欠陥（(2)(3)）を発見し修正した。
- **M3 の locator 引用 E2E をローカルスタックで実行**: `mise run test:e2e:ollama`（`docker compose up -d`
  + Ollama）で `locator-citation.spec.ts` を通し、PDF `--via-parser` → チャット引用に locator が
  出ることを実機確認（本 Check では未実行）。
- **pre-existing 技術負債の別 spec 化**: Next.js/sharp CVE（lockfile 起因 12 件）と NODE_ENV build
  quirk（`global-error.tsx` prerender）は本 spec スコープ外。依存更新 spec として切り出す。
- **Req 5.4 の閾値ブロック有効化を確認**: `GOLDEN_SET.length === 20 === PR_GATE_MIN_CASES_FOR_BLOCKING`
  のため report-only 条件は現在 false（=ブロック有効）。次 PR で `eval-pr.yml` が実際に閾値判定へ
  遷移することを 1 度観測する。
- **Task 11 の per-step 検証ポリシー**: 複数 doc-gen ステップで異なる acceptanceCriteria/llmVerify を
  使い分けるニーズが出たら `SpecialistInput` の document-generation バリアント schema 拡張を検討
  （本タスクでは boundary 外で見送り）。
- **steering / AGENTS.md 反映**: 上表の候補ルール（境界契約パターン / 既存シーム優先 / フェーズ毎
  adversarial-review / `_Boundary:_` 周辺ファイル）を次の steering 更新でまとめて取り込む。
- **Serena メモリ更新**: `patterns/single-source-boundary-contract-drift` を追加（Step 5 で実施）。
