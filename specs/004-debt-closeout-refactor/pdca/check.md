# 004-debt-closeout-refactor — Check(検証結果)

日付: 2026-07-24。判定: **全 AC 充足(6.3 は [E] 節どおり honest-skip を記録)**。

## ゲート実行結果

| ゲート | 結果 | 備考 |
| --- | --- | --- |
| `pnpm exec biome check .` | ✅ | 139 files、fix 0(organizeImports 1 件は Do 中に自動修正済み) |
| `pnpm -r run typecheck` | ✅ | 全 workspace member(web/worker の tsc + evals の standalone tsc 含む) |
| `pnpm exec vitest run` | ✅ | **54 files / 573 passed / 1 skipped**(移動後の `packages/db/tests/schema.spec.ts` 含む) |
| `pnpm exec vitest run --coverage` | ✅ | lines **88.56%** / functions **87.38%**(閾値 80。R2 移動後 + R5.4 除外後) |
| `bash scripts/forbid-model-ids.sh` | ✅ | apps/packages/services 走査、検出 0 |
| `pnpm audit --audit-level=moderate` | ✅ | 0 件 |
| pre-commit フック(全 5 ステップ) | ✅ | 4 コミットすべてで通過(step 5 の model-ids は本 spec で追加後に有効) |
| workflow YAML パース | ✅ | lint.yml / python.yml / tests.yml |
| `pnpm exec playwright test --list` | ✅ | 22 tests / 5 files(E2E spec のパース・構文検証) |
| `docker compose --profile sidecar config` | ✅ | profile 付き compose の構造検証 |

## AC 別判定(要点)

- **R1(台帳)**: spec.md「Out of Scope / Future Work」に A(トリガー待ち 10)/ B(意図的設計 3)/
  C(運用者アクション 3)を検証日付きで確定。✅
- **R2(分割)**: `packages/db` 新設・3 ファイル rename 移動・残存 `@vaz/rag/db/schema` grep 0 件・
  依存 honest graph 化・lockfile 最小差分・全ゲート green。**挙動変更ゼロ**(DDL/SQL 内容
  無変更、テスト数 573 で増減なし=移動のみ)。✅
- **R3(整合)**: stale 文言 5 種の残存 grep 0 件。steering 4 件追加。✅
- **R4(追認)**: `email.ts` の `assertAllowedRecipient` 配送前呼び出し + allow/reject テストを
  確認(gap-analysis 4.1)。docstring 是正済み。✅
- **R5(CI 配線)**: lint.yml / pre-commit / python.yml / coverage 除外すべて実装。
  **python.yml の初回実走は push 後の CI で観測**(本ブランチは `services/agent/**` に触れる
  ため path-filter が発火するはず — act.md 申し送り)。✅(実走観測のみ委譲)
- **R6(E2E 修正)**: 2 原因の修正 + パース検証 ✅。**6.3 実スタック実走は honest-skip**(下記)。
- **R7(compose profile)**: 構造検証 ✅(イメージ実ビルドは委譲 — 下記)。

## Honest-skip 記録(6.3 / 7.1 実ビルド)

- 実装環境に docker デーモン・Ollama・uv が存在しないため、`mise run test:e2e:ollama` の
  実スタック実走と sidecar イメージの実ビルド(`docker compose --profile sidecar up -d` →
  `/healthz` probe)は本セッションで実施できない。
- 修正の妥当性根拠: (a) `{ exact: true }` は `Chat.tsx:62` の `<strong>You</strong>`(全文が
  正確に "You")に一意一致し、応答本文の部分文字列 "You" を除外する — Playwright strict mode の
  セマンティクスから決定的。(b) センチネル文は行末欠落の被害位置を codename から犠牲文へ移す
  配置変更であり、アサーション対象(`Nightjar-19` / `"locator"`)は無変更。
- 委譲先: ローカルスタック保持者による `docker compose --profile sidecar up -d` + Ollama +
  `mise run test:e2e:ollama` 1 回(act.md 申し送り 1)。

## 棚卸し検証の再現性

台帳 B(意図的設計)の根拠 grep はいずれも 1 コマンドで再現可能:
`data-processing` throw(`packages/agents/src/supervisor.ts` の `SpecialistUnavailableError`)、
`JobStore` サーフェス(`apps/worker/src/stores.ts` の export)、allowlist 配線
(`grep -n assertAllowedRecipient packages/tools/src/email.ts`)。
