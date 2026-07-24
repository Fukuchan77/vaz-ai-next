# 004-debt-closeout-refactor — Implementation Tasks

`plan.md` に準拠。散文は日本語、識別子・型・パス・コードは英語。

規約(002/003 と同一):

- `- [ ]` 未着手 / `- [x]` 完了 / `- [ ]*` 任意・後回し可。
- `(P)` = 並列実行安全(依存なし・境界が互いに素)。
- 全タスクは `_Boundary:_` と `_Depends:_` を宣言する。
- `_Requirements:_` は要件 ID のみをカンマ区切りで列挙する。

## Task 依存図

```
Task 1(@vaz/db 分割)──→ Task 2(coverage 再確認は 1 の後が確実)
Task 2(CI ゲート配線)(P)
Task 3(ドキュメント整合 + allowlist docstring)(P)
Task 4(E2E 修正 + sidecar profile)(P)
Task 5(台帳確定・pdca)── 1〜4 の結果を記録するため最後
```

NFR-1: Task 1〜4 は独立着地可能(上記順序は推奨であって依存ではない。唯一の実依存は
Task 2 の coverage 除外検証が Task 1 のファイル移動後の数値で行われること)。

---

## 1. `@vaz/db` パッケージ分割

_Boundary:_ `packages/db/**`(新設), `packages/rag/src/db/schema.ts`(削除),
`packages/rag/drizzle/**`(削除), `packages/rag/tests/schema.spec.ts`(移動),
`packages/rag/package.json`, `apps/worker/package.json`, `packages/evals/package.json`,
`packages/agents/package.json`, `pnpm-lock.yaml`, import 書換対象 16 ファイル,
`AGENTS.md`, `CLAUDE.md`(dep-graph 記述)
_Depends:_ none
_Requirements:_ 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, NFR-2

- [x] 1.1 `packages/db/package.json` 新設(source-only 慣例、deps: drizzle-orm/drizzle-zod/zod、
  devDeps: `@vaz/schemas`)。
- [x] 1.2 `git mv` で schema.ts / `drizzle/0000_add_locator.sql` / `tests/schema.spec.ts` を移動。
  schema.ts ヘッダの「later refactor」段落を削除。テストの import を `@vaz/db/schema`
  (self-referencing specifier)へ。
- [x] 1.3 全 `@vaz/rag/db/schema` import を `@vaz/db/schema` へ書換(残存 grep ゼロ確認)。
- [x] 1.4 package 依存の honest graph 化(plan.md の表どおり)+ `pnpm install`(lockfile 差分は
  リンク張替えと packages/db 追加のみ)。
- [x] 1.5 AGENTS.md / CLAUDE.md の dep-graph・パッケージ一覧・スキーマ所在を同一コミットで更新。
- [x] 1.6 ゲート: biome / `pnpm -r typecheck` / vitest(573 pass)/ coverage 閾値 /
  `forbid-model-ids.sh` / `pnpm audit` すべて green(pre-commit フック全通過で追認)。

## 2. CI ゲート配線

_Boundary:_ `.github/workflows/lint.yml`, `.github/workflows/python.yml`(新設),
`.githooks/pre-commit`, `mise.toml`, `vitest.config.ts`
_Depends:_ Task 1(coverage 数値の最終確認のみ — 着手自体は独立)
_Requirements:_ 5.1, 5.2, 5.3, 5.4, NFR-3

- [x] 2.1 `lint.yml` に Model-ID gate ステップ(checkout 直後、install 不要)。
- [x] 2.2 `.githooks/pre-commit` step 5/5 追加 + ヘッダコメント是正。
- [x] 2.3 `python.yml` 新設(path-filter → mise-action → `mise run py:check`)。`mise.toml`
  `[tools]` に `uv = "0.9"` ピン。`gate` 非包含の理由を workflow コメントに明記。
- [x] 2.4 `vitest.config.ts` coverage exclude に `pr-gate.ts`(nightly.ts と同型コメント)。
  除外後 coverage: lines 88.56% / functions 87.38%(閾値 80 維持)。
- [x] 2.5 検証: workflow YAML パース OK / `forbid-model-ids.sh` ローカル green。

## 3. ドキュメント整合 + allowlist docstring 是正 (P)

_Boundary:_ `AGENTS.md`, `CLAUDE.md`, `packages/tools/src/allowlist.ts`
_Depends:_ none
_Requirements:_ 3.1, 3.2, 3.3, 3.4, 4.1, 4.2

- [x] 3.1 「Active Spec: 002」節を恒久「Python sidecar(`services/agent`)」節へ書換
  (stale 表現の排除、恒久不変条件のみ残す)。
- [x] 3.2 ingest CLI 行を bin script 実在に合わせて是正(`--via-parser` は拡張子フィルタ無しの
  事実も実コード確認の上で記載)。
- [x] 3.3 002 レトロ steering 4 件を「Design & process rules(002 retrospective, adopted spec 004)」
  節として Non-Obvious Patterns へ追加。
- [x] 3.4 `allowlist.ts` docstring を「配線済み」へ是正(R4.1 の追認: `email.ts` の
  `assertAllowedRecipient` 呼び出しと allow/reject テストの存在を確認済み)。
- [x] 3.5 stale 文言(「no bin script」「currently scans」「Active Spec」「future refactor」
  「does NOT pass」)の残存 grep ゼロ確認。

## 4. M3 locator E2E 修正 + sidecar compose profile (P)

_Boundary:_ `apps/web/tests/e2e/locator-citation.spec.ts`,
`apps/web/tests/e2e/chat-ollama.spec.ts`, `apps/web/tests/e2e/chat-anthropic.spec.ts`,
`services/agent/Dockerfile`(新設), `docker-compose.yml`
_Depends:_ none
_Requirements:_ 6.1, 6.2, 6.3, 7.1, 7.2

- [x] 4.1 3 spec の `getByText("You")` → `{ exact: true }`(原因 (a) の理由コメント付き)。
- [x] 4.2 `DISTINCTIVE_FACT` へセンチネル文追記(原因 (b) の理由コメント付き。アサーション無変更)。
- [x] 4.3 `services/agent/Dockerfile` 新設 + compose `sidecar` サービス
  (`profiles: ["sidecar"]`、`/healthz` healthcheck、既定 compose 無影響)。
- [x] 4.4 検証: `playwright test --list` 22 tests パース OK / `docker compose --profile sidecar
  config` OK。
- [ ]* 4.5 `mise run test:e2e:ollama` の実スタック実走(docker + Ollama + sidecar 到達環境。
  本 spec の実装環境では docker デーモン・Ollama 不在のため honest-skip — pdca/check.md 記録、
  6.3 の [E] 節どおりローカル/CI 追跡へ委譲)。

## 5. 台帳確定・spec ドキュメント・PDCA クローズ

_Boundary:_ `specs/004-debt-closeout-refactor/**`
_Depends:_ Task 1〜4(結果の記録)
_Requirements:_ 1.1, 1.2, 1.3

- [x] 5.1 spec.md「Out of Scope / Future Work」台帳の確定(A: トリガー待ち 10 項目 /
  B: 意図的設計 3 件の検証記録 / C: 運用者アクション 3 件の現況)。
- [x] 5.2 plan.md / tasks.md / gap-analysis.md の整備。
- [x] 5.3 pdca/do.md(実施ログ)・check.md(検証結果 + honest-skip 記録)・act.md(申し送り)。
