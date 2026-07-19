# 002-pydantic-enhance — PDCA Do Phase

## Task 1.1 — `packages/schemas/src/run-metrics.ts`

- **RED**: `packages/schemas/tests/run-metrics.spec.ts` を先行作成（13 テスト）。
  `@vaz/schemas/run-metrics` が存在せず `Cannot find package` で失敗することを確認。
- **GREEN**: `run-metrics.ts` に `runStopReasonSchema`（閉じた語彙 4 値、ADR-A）と
  `runMetricsSchema`（`stopReason` + `inputTokens`/`outputTokens`/`totalTokens`
  + `stepCount`、ADR-D/E）を実装。フィールド名は v7 usage 形状
  （`inputTokens`/`outputTokens`/`totalTokens`）に合わせ、`stepCount` は
  `positive()`（run は最低 1 ステップ）、token 数は `nonnegative()`。
- **SCAN**: 新規ファイルのため既存テスト影響なし。回帰ベースラインとして
  `packages/schemas` 配下 7 ファイル/81 テストを実行し実装前後とも green。
- **VERIFY**:
  - `pnpm exec vitest run --project packages packages/schemas/tests/run-metrics.spec.ts`
    → 13 passed
  - `pnpm exec vitest run --project packages packages/schemas` → 7 files / 81 tests passed
  - `pnpm exec biome check packages/schemas/src/run-metrics.ts packages/schemas/tests/run-metrics.spec.ts`
    → clean（1 回 `--write` でフォーマット自動修正）
  - `mise run typecheck` → 全 9 ワークスペース green
  - `mise run test:run` → 46 files / 415 tests passed（既存回帰なし）
- **結果**: tasks.md の 1.1 を `[x]` に更新。

## Task 1.2 — `packages/schemas/src/env.ts`

- **RED**: `env.ts` に対する単体テストが存在しなかった（`aiEnvSchema`/`parseAiEnv` は
  `packages/config/tests/model-allowlist.spec.ts` から間接的に触られるのみ）ため、
  `packages/schemas/tests/env.spec.ts` を新設（5 テスト: default 200_000 / 数値文字列の
  coerce / 空文字 → unset → default フォールバック / 非正値 reject / 非整数 reject）。
  `CHAT_TOKEN_BUDGET` 未実装のため `undefined`/`toThrow` 失敗を確認。
- **GREEN**: `aiEnvSchema` に
  `CHAT_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000)` を追加し、
  `parseAiEnv` の組み立てオブジェクトに既存の `emptyToUndefined(env.CHAT_TOKEN_BUDGET)` を
  追加（他フィールドと同じ空文字→unset パターンで一貫性を保つ）。
- **SCAN**: `packages/config/tests/model-allowlist.spec.ts`（`parseAiEnv` 経由の drift
  guard）+ `packages/schemas/tests/auth-env.spec.ts` を回帰ベースラインとして実装前後で
  実行、green 維持を確認。
- **VERIFY**:
  - `pnpm exec vitest run --project packages packages/schemas/tests/env.spec.ts`
    → 5 passed
  - `pnpm exec vitest run --project packages packages/config/tests/model-allowlist.spec.ts packages/schemas/tests/env.spec.ts packages/schemas/tests/auth-env.spec.ts`
    → 3 files / 12 tests passed（既存回帰なし）
  - `mise run test:run` → 47 files / 420 tests passed
  - `mise run typecheck` → 全 9 ワークスペース green
  - `mise run lint` → `Checked 125 files. No fixes applied.`
- **結果**: tasks.md の 1.2 を `[x]` に更新。

## Task 1.3 — `packages/schemas/src/deps.ts`

- **RED**: `packages/schemas/tests/deps.spec.ts` に `runAuditEntrySchema`/`RunAuditEntry`
  の describe ブロックを先行追加（8 テスト: well-formed 受理 / null userId・jobId 許容 /
  非 UUID jobId 拒否 / 語彙外 stopReason 拒否 / 負トークン数拒否 / string ts 拒否 /
  stopReason 欠落拒否）。`@vaz/schemas/deps` に未実装のため `Cannot read properties of
  undefined (reading 'safeParse')` で失敗することを確認。
- **GREEN**: `deps.ts` に `runAuditEntrySchema = runMetricsSchema.extend({ userId, jobId, ts })`
  を追加（Task 1.1 の `runMetricsSchema` を単一正本として再利用し、stopReason/token 数/
  stepCount を重複定義しない）。`AuditSink` に optional `recordRun?(entry: RunAuditEntry):
  void | Promise<void>` を追加（既存 `record` は不変、未実装 sink は no-op で後方互換、
  ADR-D/R4.7）。
- **SCAN**: 回帰ベースラインとして実装前に `packages/schemas` 配下 8 ファイル/86 テストを
  実行し green を確認、実装後も再実行して 8 ファイル/94 テストで green を確認
  （既存 `auditEntrySchema` 系 8 テストに新規 8 テストが加わっただけで既存回帰なし）。
- **VERIFY**:
  - `pnpm exec vitest run --project packages packages/schemas/tests/deps.spec.ts`
    → 16 passed
  - `pnpm exec vitest run --project packages packages/schemas` → 8 files / 94 tests passed
  - `mise run test:run` → 47 files / 428 tests passed（既存回帰なし）
  - `mise run typecheck` → 全 9 ワークスペース green
  - `mise run lint` → 初回 2 件のフォーマット差分（新規テストの改行）を検出 →
    `mise run lint:fix` で自動修正 → 再実行で `Checked 125 files. No fixes applied.`
- **結果**: tasks.md の 1.3 を `[x]` に更新。

## Task 1.4 — `packages/schemas/src/workflows.ts`

- **RED**: `packages/schemas/tests/workflows.spec.ts` の `jobEventSchema` describe に
  3 テストを先行追加（job-level completion が `metrics` を受理 / `metrics` 省略でも
  受理=SSE wire 後方互換 / 語彙外 `stopReason` を含む malformed `metrics` を拒否）。
  実行して「malformed `metrics` を拒否」のみ失敗（`metrics` が未定義フィールドとして
  無視され `success: true` になる）することを確認、他 2 テストは `metrics` 未実装でも
  optional 相当の挙動のため事前に green だった旨を記録。
- **GREEN**: `workflows.ts` に `runMetricsSchema`（`./run-metrics`）をインポートし、
  `completion` バリアントへ `metrics: runMetricsSchema.optional()` を追加（Task 1.1 の
  正本を再利用、discriminated union の判別子・`jobEventTypeSchema`・DB enum は不変）。
- **SCAN**: 回帰ベースラインとして実装前に `workflows.spec.ts` + `run-metrics.spec.ts` +
  `deps.spec.ts` を実行し 3 files / 61 tests green（新規 3 テスト込みで 1 件のみ red）
  を確認、実装後に同じ 3 ファイルを再実行して 3 files / 64 tests green を確認。
- **VERIFY**:
  - `pnpm exec vitest run --project packages packages/schemas/tests/workflows.spec.ts packages/schemas/tests/run-metrics.spec.ts packages/schemas/tests/deps.spec.ts`
    → 3 files / 64 tests passed
  - `mise run test:run` → 47 files / 431 tests passed（既存回帰なし）
  - `mise run typecheck` → 全 8 ワークスペース green
  - `mise run lint` → `Checked 125 files. No fixes applied.`
- **結果**: tasks.md の 1.4 を `[x]` に更新。

## Learnings

- `@vaz/schemas` の既存パターン（`eval.ts`/`workflows.ts`）は JSDoc コメントで
  「なぜこの形状か」（ADR 参照）を書く規約。`run-metrics.ts` も同様に ADR-A/D/E への
  参照をコメントに残した。
- Biome のフォーマットは長い `test.each([...])` 配列や 100 文字を超える 1 行 `expect`
  チェーンを自動改行する。手書き時に整形前提で書かず `--write` を通すのが速い。
- `env.ts` の各フィールドは `emptyToUndefined` を通してから `aiEnvSchema.parse` に渡す
  一貫パターンがあるため、新フィールド追加時はスキーマ定義とビルドオブジェクトの
  両方を同時に更新しないと「空文字が default にフォールバックしない」不整合が生まれる
  （テストの 3 番目のケースがこれを固定）。
