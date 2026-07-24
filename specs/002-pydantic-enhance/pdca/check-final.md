# Check Phase — 002-pydantic-enhance（Final / Phase C・D・E + フィーチャ完了）

PDCA Check: 実装結果（Do）を計画（Plan）と照合する。`/sdd-reflect 002-pydantic-enhance`
により生成。Phase A は `check.md`、Phase B は `check-phaseB.md` が担当済み。本 Check は
Phase C（Req 3）・Phase D（Req 4）・Phase E（Req 5, 6）と、`/sdd-validate-impl` による
フィーチャ全体の GO 判定を対象とする。

## Expectations vs. Results

| Expectation (from plan) | Result (from do) | Status |
|-------------------------|------------------|--------|
| **Phase C**: Pydantic 正本 → OpenAPI → `openapi-typescript` 生成 TS（コミット）+ 薄い Zod + 契約ドリフト 1 点照合（ADR-B, Req 3.1–3.5） | `generated/agent-service.ts` + `openapi.snapshot.json` コミット済み。薄い Zod は `satisfies z.ZodType<Generated>` でコンパイル時 conform。`contract-drift.spec.ts` は 2-leg（snapshot↔生成型 文字列一致 / snapshot↔Zod 形状比較）で 1 テストに集約 | ✅ |
| **Phase D**: `/parse`（Docling `HybridChunker`、LlamaParse opt-in）+ optional `locator` + ingest `--via-parser`（単一ライター不変・provenance 不変・fail-loud、Req 4.1–4.6） | `/parse` 実装、`retrievedChunkSchema`/chunk テーブルに nullable `locator`、migration `0000_add_locator.sql`。`--via-parser` は既存 `embed`/`assertNoProviderMixing`/`upsertDocument` を再利用。到達不可時 actionable error。既定経路は `locator` 未セットで byte 互換 | ✅ |
| **Phase E / Req 5**: golden set ≥20、nightly tier2（未設定時 skip）、PR ゲート 3 指標（<20 件 report-only）、doc-gen 検証（Doer-Verifier, Req 5.5–5.7） | `GOLDEN_SET` = 20 件、`tier2.ts` + `eval-nightly.yml` tier2 ステージ、`pr-gate.ts` 3 指標 + `eval-pr.yml`（`PR_GATE_MIN_CASES_FOR_BLOCKING`=20）、`supervisor.ts` に `verifyDocument` optional（未設定=skip、`DocumentVerificationInput` は成果物+基準の 2 フィールドのみ） | ✅ |
| **Phase E / Req 6**: `docs/agentops.md`（3 本柱写像・CLAUDE.md 到達）+ MCP ADR（非採用根拠・採用条件・設計原則・§5.1/§5.2 参照） | `docs/agentops.md`・`docs/adr/0001-mcp-position.md` 作成、`CLAUDE.md` からリンク。文書参照シンボルを ship-gate で全件実在確認 | ✅ |
| **NFR-2**: model-id ゲートを `services/**` `*.py` へ拡張（`config.py` carve-out） | `forbid-model-ids.sh` が `apps/**, packages/**, services/**` を走査、検出ゼロ | ✅ |
| **NFR-1/6**: 全フェーズ独立着地・既存ゲート緑維持・`JobEvent` 後方互換 | 各 Phase の feat コミットが独立、`JobEvent.metrics` は optional 追加 | ✅ |

## Test & Quality Outcomes

- **TS ユニット**: 551 passed / 54 files（`mise run test:run`, exit 0）。Phase 進行で 465→482→483→501→551 と単調増加、既存回帰なし。
- **Python `py:check`**: ruff clean / pyright strict **0 errors** / pytest **57 passed**（ネットワークゼロ、`httpx.ASGITransport`）。
- **typecheck**: `pnpm -r run typecheck` 全 workspace green（exit 0）。※`mise run check` 並列実行時に `apps/worker` が SIGTERM で一時異常終了したが単独実行は green — 並列リソース競合と判断。
- **lint / format**: Biome 137 files, no fixes。
- **model-id ゲート**: `services/**` 走査込みで検出ゼロ。

## Requirements Coverage

- **Covered（本 Check 対象）**: Req 3（3.1–3.5）/ Req 4（4.1–4.6）/ Req 5（5.1–5.7）/ Req 6（6.1–6.3）/ NFR-1, NFR-2, NFR-6 = **全件**。
- フィーチャ全体: Req 1–6 + NFR 1–6 すべて実装へ追跡可能（`/sdd-validate-impl` GO）。
- **Gaps**: なし（機能要件レベル）。

## Deviations from Design

- **`_Boundary:_` 事後補正が Phase D で継続**: Task 7 で `config.py`（LlamaParse キー、Task 4.2 の境界）+ `main.py` router 配線 + `uv.lock` を、Task 7 境界へ TDD テストファイル 2 件含め追記。いずれも scaffold/配線に必須で下流契約に無影響、`/sdd-validate-impl` が CRITICAL 検出→tasks.md 境界を実態へ一致（Task 1.5 で確立した作法）。
- **Task 11 の acceptanceCriteria 出所**: 新規 schema フィールドを足さず既存 `task.instructions` を再利用。`DocumentVerificationInput` を 2 フィールドに狭めることで「会話履歴を渡さない」（Req 5.6）を構造的に保証 — plan の意図を schema 拡張なしで満たす良い逸脱。
- **Task 11 検証失敗の JobEvent**: 新規 publish/throw を書かず、`DocumentVerificationError.reason: RunStopReason = "error"` を既存の duck-typed catch へ素通し（Req 5.7 の閉じた語彙を新語彙ゼロで充足）。

## Issues Encountered

| Issue | Root cause | Resolution |
|-------|-----------|------------|
| 生成 TS が biome の tab 強制と衝突 | openapi-typescript は 4-space 整形 | `biome.json` の `files.includes` で生成ディレクトリを除外（手動整形せず、ADR-B の「コミット物=生成出力」不変条件を保護） |
| `satisfies z.ZodType<Generated>` は余剰フィールドを検出しない | zod v4 の `out Output` 共変 | 現状 1:1 で問題なし。将来の余剰追加は contract-drift の Leg 2 が補完（申し送り） |
| `mise run build` が `NODE_ENV` 非標準時に `/_global-error` prerender で失敗 | pre-existing（本 spec のどの Task も `global-error.tsx` 未改変） | `NODE_ENV=production` で回避確認、6 ルート正常生成 |
| `mise run audit` non-zero（Next.js/sharp CVE 12 件） | lockfile 起因の pre-existing 技術的負債（本 spec は依存未変更） | スコープ外として別途追跡（Task 8/9/12 で既記録） |
| **Phase C/D/E で `/adversarial-review` 未実施** | Phase A/B は reflect 直後にフレッシュコンテキスト review を実施し実欠陥（Req 1.5/2.7b の「契約はあるが未配線」）を検出したが、C/D/E では未実行 | merge 前に実施済み。実欠陥 5 件を検出・修正: (1) `checkDocumentMechanically` の HTML マッチが `<tag>[\s\S]*</tag>` バックトラッキング正規表現で ReDoS 可能（プロンプトインジェクション文書からの DoS 経路）→ 開閉タグの線形 2 スキャンへ置換、(2) `pr-gate.ts` が持続的な `case-failed`（インフラの慢性的フレーキーさ）を PR ブロック要因に含めていた → baseline で graded だったケースが新規に落ちた場合のみブロックする `hasNewCaseFailure` を切り出し、(3) `tier2.ts` がスキーマ不整合応答（境界契約ドリフト）を `request-failed`（サービス到達不可）と区別せず握っていた → `invalid-response` reason を追加、(4) ingest CLI の `/parse` レスポンスが `as ParsedChunk[]` で無検証キャストされていた（fail-loud 不徹底）→ `parsedChunksSchema`（`@vaz/schemas/agent-service` 新設）で検証、(5) `/parse` の `use_llamaparse=true`+キー設定時に未実装の LlamaParse へサイレントフォールバックしていた → `501 Not Implemented` で明示的に拒否。全 5 件を TS 560 / Python 58 テスト green・lint/typecheck/model-id ゲート green で確認後 `/sdd-ship` でコミット |

## Assessment

Phase C・D・E は計画（plan.md / research.md ADR-B/PL-2/RV-4/RV-7）どおり着地し、
`/sdd-validate-impl` がフィーチャ全体を **GO** と判定。全 12 タスク `[x]`、TS 551 /
Python 57 テスト green、境界は per-task ship-gate で調整済み。プロダクション可否は
**機能・品質ゲート観点では Ready**。留保は 2 点: (1) pre-existing な Next.js/sharp
CVE と NODE_ENV build quirk（本 spec スコープ外、要別追跡）、(2) M3 の locator 引用
E2E はローカルスタック必須のため本 Check では未実行。

Phase C/D/E への独立 `/adversarial-review` は merge 前に実施済み（上記 Issues 参照）。
実欠陥 5 件（ReDoS・PR ゲートの過剰ブロック・tier2 のドリフト誤分類・ingest の無検証
キャスト・`/parse` のサイレントフォールバック）を検出・修正し、再度 TS 560 / Python 58
テスト green・lint/typecheck/model-id ゲート green を確認。A/B/C/D/E 全フェーズに独立
検証の網が掛かった状態で **GO**。
