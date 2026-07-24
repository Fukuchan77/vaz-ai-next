# 003-dependency-security-hardening — Implementation Gap Analysis

散文は日本語、識別子・型・パス・コード・GHSA は英語(`spec.json` `language: ja`)。
`~/.claude/sdd/rules/gap-analysis.md` フレームワークに準拠。**判断ではなく情報と選択肢**を提供する。

> 状態: 本 feature は既に `phase: tasks-generated`(spec/plan/tasks 生成済み・未承認)。
> 通常 gap-analysis は plan 前に走るが、本書は要件⇔現状コードの突合により
> 既存 plan.md の妥当性確認と、閉じられる研究フラグの明示を目的とする。

## Analysis Summary

- **スコープの性質**: 本 spec の主産物は運用文書(`docs/dependency-policy.md` 新設)と
  CI 構造変更であり、アプリケーションコードの振る舞い変更は R4 の Python 2 ファイルのみ。
  止血(R1.1/R1.2)は起票ブランチで実施済み・現状コードで **✅ 確認できた**。
- **最大の未実装ブロック**は文書(`docs/dependency-policy.md` — R1.3/R1.5/R2.4 が集約)と
  CI ジョブ分離(`tests.yml` の Security Audit が現状 `unit` ジョブ内の直列ステップ)。
- **研究フラグ 1 件を本分析で解消**: `to_token_usage`(R4.2)が依存する Pydantic AI
  `RunUsage` は `total_tokens` を **実際に公開している**(検証済み)。plan.md/tasks.md 5.2 の
  「有無を実装時に確認」フラグは「provider-reported total 採用」側に確定可能。
- **統合上の主課題**は 2 点: (a) audit 独立ジョブ化は分岐保護の required-checks 更新という
  **リポジトリ設定操作**を伴い、コードだけでは完結しない(Task 3.2 が fallback を明示)、
  (b) R5.2 は docker compose + Ollama という**環境依存**の実行が前提。
- **推奨アプローチは Extend(既存パターン踏襲)**。overrides/allowBuilds のコメント付き
  committed-decision 様式、`mise` のインライン env 様式(`test:e2e:ollama`)、
  `forbid-model-ids.sh` の carve-out 様式に完全に載る。plan.md の設計と整合。

## Per-Requirement Gap Table

凡例: ✅ 既存コードで充足 / 🔧 一部存在(拡張要) / 🆕 新規構築 / 👁 観測・記録のみ(コード変更なし)

### Requirement 1 — advisory 対応の追認と恒常運用

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 1.1 | ✅ | `apps/web/package.json:22-23` — `next: ^16.2.11`, `next-auth: 5.0.0-beta.32`。lockfile 更新済み(要 `pnpm audit` exit 0 の再確認)。 |
| 1.2 | ✅ | `pnpm-workspace.yaml` `overrides` に `sharp@<0.35.0`/`js-yaml@>=4.0.0 <4.3.0`/`brace-expansion@>=2.0.0 <2.1.2`(各 GHSA ID・理由・撤去条件コメント付き)。加えて `postcss@<8.5.10`(先行 spec 由来)。 |
| 1.3 | 🆕 | `docs/dependency-policy.md` は**存在しない**(`docs/` は adr/agentops/context-budget 等のみ)。runbook 全文が新規。 |
| 1.4 | 🔧 | 撤去条件は override コメントに既記(`"dropped once next's stable dependency range includes 0.35"`)。runbook 側の撤去条件表(R1.3 内)が未整備。 |
| 1.5 | 🆕 | Renovate/Dependabot 採否基準の記録なし(R1.3 文書に内包)。 |

### Requirement 2 — audit ゲートの回復可能性と CI 構造

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 2.1 | 🆕 | `.github/workflows/tests.yml` は Security Audit を **`unit` ジョブ内の直列 step**(`Install → Security Audit → Test`)として実行。audit 失敗で Test が走らない現状そのもの。独立 `audit` ジョブが未構築。 |
| 2.2 | 🔧 | 「両ジョブ required 維持」は**分岐保護 required-checks 設定**の話。現状 audit は独立チェックではないため、分離後に repo 設定変更が必要。Task 3.2 が「設定不可なら PR 説明に手順明記」の fallback を宣言済み。 |
| 2.3 | 🆕(意図的空) | `auditConfig.ignoreGhsas` は **未導入**。plan は「空で入れず、必要時に R2.3 書式で追加/書式例は runbook に置く」方針。現状と整合。 |
| 2.4 | 🆕 | `ignoreGhsas` の一時性・PR 毎レビュー・期限超過=債務、の記述先 `docs/dependency-policy.md` が未存在。 |

### Requirement 3 — NODE_ENV build quirk

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 3.1 | 🆕 | `mise.toml:14-15` `[tasks.build]` = `pnpm --filter @vaz/web exec next build` — `NODE_ENV=production` を**前置していない**。 |
| 3.2 | 🆕 | `tests.yml` e2e `Build` step(`pnpm --filter @vaz/web run build`)に `NODE_ENV` 明示なし。 |
| 3.3 | 🔧 | `apps/web/src/app/global-error.tsx` の NOTE は quirk と「`NODE_ENV=production` でクリーンに prerender」を既に説明。ただし**強制されたビルドパス(mise/CI)への参照がない**(そのパスが R3.1/3.2 で初めて生じるため後行更新)。 |

### Requirement 4 — 002 積み残しの小粒ハードニング

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 4.1 | 🔧 | `services/agent/app/routes/eval.py:49,67` に bare `assert judge.last_usage is not None, "..."` が 2 箇所。`RuntimeError` 送出へ置換(pyright strict の narrowing 維持のためローカル変数化)。 |
| 4.2 | 🔧 | `services/agent/app/eval/llama.py:162-168` `to_token_usage` は現状 `total = input + output` を**再計算**。**本分析の検証で `RunUsage.total_tokens` の存在を確認**(`cache_read_tokens`/`cache_write_tokens` 等も公開)→ plan の推奨側(provider total 採用 + 境界コメント)へ確定可能。 |
| 4.3 | 🆕 | 002 の `spec.md`(Req 2.7 は L145 に存在するが「2.7b」表記なし)/`tasks.md`(L164-169 で `traced_span` を Req 2.7 配下に記載するが「Phase E 所管」の明文なし)に、Req 2.7b traced_span 配線が Phase E 所管である旨の注記が**ない**。 |

### Requirement 5 — 002 の運用上の未実施確認

| AC | 分類 | 根拠 / 現状 |
| --- | --- | --- |
| 5.1 | 👁 | **前提を検証済み**: `nightly.ts` GOLDEN_SET は 20 件、`pr-gate.ts:25` `PR_GATE_MIN_CASES_FOR_BLOCKING = 20`、`pr-gate.ts:143` `reportOnly = size < 20` → **`reportOnly=false`(閾値ブロック稼働中)**。本 spec の PR で遷移を観測・記録するのみ。 |
| 5.2 | 👁 | `mise run test:e2e:ollama`(docker compose + Ollama)の 1 回実行と結果記録。コード変更なし・**環境依存**。 |
| 5.3 | 👁 | 依存バンプ後 nightly の tier1/tier3 verdict 変化があれば before/after を記録(なければその旨)。任意・後回し可(tasks 7.3*)。 |

## Integration Challenges

- **CI required-checks 更新はコード外操作(R2.1/R2.2)**: `tests.yml` の job 分離は PR に載るが、
  「audit を required gate に維持」は GitHub の branch protection 設定。実行者が repo 管理権限を
  持たない場合、Task 3.2 の fallback(PR 説明に運用手順を明記)へ倒す。**plan/tasks は既にこれを想定済み**。
- **ジョブ分離の重複コスト**: 独立 `audit` ジョブは checkout/mise/pnpm-setup/install を再実行する。
  `unit` と直列だった頃より CI 秒数は増える(可視性とのトレードオフ、spec が明示した狙い)。
- **R3 の検証条件が広い(R3.1/3.2/3.3)**: 「`NODE_ENV` 未設定 **かつ** `NODE_ENV=development` の
  シェルから `mise run build` が 6 ルートを prerender 成功」(tasks 4.4)。単なる env 追加だけでなく
  クリーンシェルでの再現確認が受入基準に含まれる。
- **R4.1 の pyright strict narrowing**: `assert` を除去すると `judge.last_usage` の型 narrowing が
  失われる。ローカル変数へ代入してから `raise` する形にしないと `to_token_usage(usage.last_usage)`
  で `None` 混入型エラーになる(plan.md L59-60 が明記)。
- **R4.2 のテスト期待値への波及**: `total_tokens` を provider 値へ切替えると、
  `services/agent/tests/` の期待値が `input+output` 前提の場合に更新が要る。`TestModel` の usage 挙動
  (cache 0 のとき total==input+output か)を実装時に確認。→ 下記 Research Flags 参照。
- **NFR-2 一貫性**: `ignoreGhsas`/overrides/allowBuilds の全変更が env・CI 変数で等価設定を作らない
  committed change であること。既存 `pnpm-workspace.yaml` のコメント様式に一致させる。
- **NFR-1 独立着地**: R1 は実施済み、R2〜R5 は任意順(tasks 依存図: Task2→Task3 のみ順序制約、
  Task4/5/6 は `(P)` 並列安全)。gap 上の衝突ファイルなし。

## Approach Options(feature 全体)

| アプローチ | 適合条件 | コスト | リスク | 評価 |
| --- | --- | --- | --- | --- |
| **A. Extend existing(推奨)** | 既存 committed-decision 様式が全対象に存在 | 低 | 低(結合はコメント規約のみ) | overrides/allowBuilds コメント様式・`mise` インライン env(`test:e2e:ollama` の `AI_PROVIDER=ollama` 前置)・`forbid-model-ids.sh` carve-out に載る。plan.md と一致。 |
| **B. Build new** | 既存パターンが乏しい場合 | 高 | 重複 | 依存監査の自動化スクリプトや policy engine 新設は本 spec の小スコープに対し過剰。不要。 |
| **C. Hybrid** | 一部のみ新規 | 中 | 統合 | 実質「Extend + 新規 artifact 1 件(`docs/dependency-policy.md`)」= 推奨 A の実態。A に包含。 |

**推奨**: **A(Extend)**。新規物は文書 1 点のみで、他は既存様式の拡張。plan.md はこの方針で
既に設計されており、gap 上の齟齬は検出されなかった。

## Research Flags(plan/impl 前に確認)

1. **[解消済] R4.2 `RunUsage.total_tokens`**: 本分析で存在を確認。plan.md L64-65 / tasks.md 5.2 の
   「有無を実装時に確認、無ければ再計算維持」は「**provider total 採用 + cache/reasoning 境界を
   docstring 明記**」側に確定できる。残タスクは (a) `tests/` 期待値の追随確認、(b) `cache_*` トークンが
   total に含まれ input+output と乖離し得る旨のコメント。
2. **[要確認] branch protection の権限(R2.2/3.2)**: 実行者が required-checks を追加できるか。
   不可なら Task 3.2 の PR 説明 fallback を採る(コード側は完結)。
3. **[要環境] R5.2 の docker + Ollama**: `docker compose up -d` と Ollama モデル取得が前提。
   ローカル/CI いずれで実行し記録するかを impl 時に決める(結果は本 spec `pdca/` へ)。
4. **[軽微] postcss override の帰属**: `pnpm-workspace.yaml` に `postcss@<8.5.10` override が
   4 件目として存在するが spec 本文(3 件想定)は言及なし。先行 spec 由来で本 spec の対象外と
   推定。R1.2 追認時に「維持のみ・撤去条件は既記」として扱えば齟齬なし。

## Traceability(gap → 変更ファイル、plan.md と一致確認済み)

| Req | 分類 | 変更ファイル |
| --- | --- | --- |
| 1.1, 1.2 | ✅ | `apps/web/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`(実施済み) |
| 1.3–1.5, 2.3–2.4 | 🆕 | `docs/dependency-policy.md`(新設), `AGENTS.md`(リンク追記) |
| 2.1–2.2 | 🆕/🔧 | `.github/workflows/tests.yml`(+ branch protection 設定) |
| 3.1 | 🆕 | `mise.toml` |
| 3.2 | 🆕 | `.github/workflows/tests.yml`(e2e Build step) |
| 3.3 | 🔧 | `apps/web/src/app/global-error.tsx` |
| 4.1 | 🔧 | `services/agent/app/routes/eval.py`(+ 既存テスト green) |
| 4.2 | 🔧 | `services/agent/app/eval/llama.py`(+ `tests/` 期待値確認) |
| 4.3 | 🆕 | `specs/002-pydantic-enhance/spec.md`(追記) |
| 5.1–5.3 | 👁 | 実施記録のみ(`specs/003-.../pdca/`) |
