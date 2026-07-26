# 004-debt-closeout-refactor — Do(実施ログ)

日付: 2026-07-24。実装は 4 コミットに分割(各コミットで pre-commit フック全 5 ステップ通過)。

## 事前棚卸し(起票の根拠)

- spec 001〜003 の全ドキュメント + `docs/`(ADR/agentops/context-budget/spikes)を横断し、
  スコープ外・保留・申し送りを全件収集(001: 17 項目、002: 19 項目、003: 14 項目 + docs 系)。
- コード側を独立に検証し「記録上保留・実態解消済み」4 件(spec.md Project Description 参照)、
  「着手可能な実債務」(R2/R5/R6)、「トリガー待ち」(台帳 A)、「意図的設計」(台帳 B)に分類。
- 検証で特に重要だった発見: `email.ts:111` の `assertAllowedRecipient` 配線済み(R4 を実装

  タスクから追認タスクへ縮小)、`forbid-model-ids.sh` の `*.py` 走査実装済み(002 NFR-2 は
  「未了」ではなく「文書だけ古い」)。

## Task 1 — `@vaz/db` 分割(commit `refactor(db): split Drizzle schema …`)

- `git mv` 3 ファイル(schema.ts / 0000_add_locator.sql / schema.spec.ts)→ rename として記録
  (履歴追跡可能)。schema.ts ヘッダの「later refactor」段落を削除。
- import 書換は `@vaz/rag/db/schema` → `@vaz/db/schema` の機械置換 + 残存 grep ゼロ確認。
  移動テストの相対 import は self-referencing specifier(`@vaz/db/schema`)へ(biome の
  organizeImports が並び替えを自動修正)。
- 依存更新は plan.md の表どおり。lockfile 差分はリンク張替え + `packages/db` importer 追加のみ
  (外部依存の新規解決なし → `allowBuilds` 変更不要)。
- `apps/worker/Dockerfile` のコメント(`node bin/ingest.ts` in @vaz/rag への類推言及)は
  分割後も事実として正しいため無変更と判断。
- ゲート: biome / `pnpm -r typecheck`(全 member green)/ vitest 573 pass / coverage
  87.0% lines / `forbid-model-ids.sh` ✅ / `pnpm audit` 0 件。

## Task 2 — CI ゲート配線(commit `ci: wire model-ID gate and Python sidecar quality gate …`)

- `lint.yml`: Model-ID gate を checkout 直後に配置(pnpm install 前 — grep のみで完結するため
  fail-fast が成立)。
- pre-commit: step 5/5 追加。ヘッダの「The hardcoded-model-id gate … is enforced by
  `mise run check`」を削除し 5 ステップ構成を記載。
- `python.yml` 新設: path-filter(`services/agent/**`, `mise.toml`, 自 workflow)→ mise-action →
  `mise run py:check`。`gate` 非包含の理由を workflow 冒頭コメントに明記。
- `mise.toml` `[tools]` に `uv = "0.9"` をピン(コメントで CI との同一 provisioning を明記)。
- `vitest.config.ts`: `pr-gate.ts` を nightly.ts と同型コメントで除外。除外後 coverage:
  **lines 88.56% / functions 87.38%**(除外前 87.0%/87.19% — 分母から低カバレッジ CLI が
  外れて上昇。閾値 80 維持)。
- 検証: 3 workflow の YAML パース OK(python3 + PyYAML)。

## Task 3 — ドキュメント整合(commit `docs: sync AGENTS.md/steering with verified reality …`)

- AGENTS.md「Active Spec: 002」→「Python sidecar(`services/agent`)」恒久節。書換で残した
  不変条件: stateless / 境界契約(OpenAPI→openapi-typescript→thin Zod)/ 単一ライター /
  model-ID ゲート Python 適用(carve-out は config.py)/ py:check の check 外スタンス +
  python.yml 参照 / openapi:gen。
- ingest CLI 行: bin script 実在を反映。`--via-parser` の拡張子挙動は実コード確認
  (`ingest/index.ts:327`「no extension filter — Docling's `/parse` decides」)に合わせ、
  当初案の「.pdf/.docx も可」ではなく「フィルタ無し(Docling が判断)」と記載(不正確さの
  作り込みを回避)。
- steering 4 件を「Design & process rules(002 retrospective, adopted spec 004)」節として追加。
- `allowlist.ts` docstring を「Wired: `createEmailCapability`'s `execute`(email.ts)calls
  `assertAllowedRecipient` before the delivery transport」へ(R4.2)。
- stale 文言残存 grep: 「no bin script / currently scans / Active Spec / future refactor /
  does NOT pass」→ AGENTS.md/CLAUDE.md でゼロ件。

## Task 4 — E2E 修正 + sidecar profile(commit `test(e2e): fix M3 locator-citation failures …`)

- 3 spec の `getByText("You")` → `{ exact: true }`。各所に原因 (a)(strict-mode 曖昧一致)の
  理由コメント。
- `DISTINCTIVE_FACT`: codename の後に犠牲文「File this brief under the quarterly compliance
  notes.」を追加し、行末 OCR 欠落(原因 (b))がセンチネルを食う配置に。`CODENAME`・`"locator"`
  アサーションは無変更。
- `services/agent/Dockerfile`: `ghcr.io/astral-sh/uv:python3.13-bookworm-slim` ベース、
  deps layer(`uv sync --frozen --no-dev --no-install-project`)を app COPY より先行、
  非 root(`agent` ユーザー)、`uv run --no-sync uvicorn`。
- compose `sidecar` サービス: `profiles: ["sidecar"]`(既定 `docker compose up -d` 無影響)、
  `/healthz` healthcheck(python urllib — イメージに curl 無し)、`ANTHROPIC_API_KEY` 透過。
- 検証: `playwright test --list` 22 tests / 5 files パース OK。`docker compose --profile
  sidecar config` OK。

## Task 5 — spec ドキュメント・台帳(本コミット)

- spec.json / spec.md(台帳含む)/ plan.md / tasks.md / gap-analysis.md / pdca 3 点を作成。

## 実装環境の制約(記録)

- サンドボックスに docker デーモン・Ollama・uv・Python3.13 実行環境は無い。`mise` は
  npm 配布版をインストールしてpre-commit フックを正規実行した(`disable_tools=node,pnpm,uv`
  でシステム版 toolchain を使用)。E2E 実走(Task 4.5)は honest-skip(check.md 参照)。
