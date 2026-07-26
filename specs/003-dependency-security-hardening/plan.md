# 003-dependency-security-hardening — Technical Plan

散文は日本語、識別子・型・パス・コードは英語(`spec.json` `language: ja`)。

## Summary

advisory 起因の Security Audit CI 失敗(2026-07-22〜)への止血は起票ブランチで実施済み。
本 plan は残る 4 領域 — (1) advisory 対応の恒常運用文書化、(2) audit ゲートの CI 構造再設計、
(3) `NODE_ENV` build quirk の恒久対処、(4) 002 積み残しの小粒ハードニング — の実装設計と、
002 の運用未実施確認 3 件の消化手順を定める。

コード変更は意図的に小さい。本 spec の主産物は **運用文書(`docs/dependency-policy.md`)と
CI 構造変更**であり、アプリケーションコードの振る舞い変更は R4(Python 2 ファイル)のみ。

## Architecture Overview

```
[advisory 公開] ─→ pnpm audit (3 箇所で同一ゲート)
                    ├── CI: tests.yml audit ジョブ(R2.1 で unit から独立)
                    ├── pre-commit: .githooks/pre-commit → mise run audit
                    └── mise run check(集約ゲート)
                         │ 失敗時の対応順序(R1.3 runbook):
                         │ 1. 直接依存バンプ(package.json)
                         │ 2. 範囲内 lockfile 更新(pnpm install / update)
                         │ 3. overrides(pnpm-workspace.yaml、GHSA・撤去条件コメント必須)
                         │ 4. ignoreGhsas(修正版なしの場合のみ、再評価期限必須)
                         └→ 検証: mise run check + NODE_ENV=production build
```

## Components

### pnpm-workspace.yaml(依存解決の単一正本 / R1, R2)

- 実施済み: `overrides` に `sharp@<0.35.0`, `js-yaml@>=4.0.0 <4.3.0`,
  `brace-expansion@>=2.0.0 <2.1.2`(各 GHSA・理由コメント付き)。
- 既存(先行 spec 由来・本 spec 対象外): `postcss@<8.5.10`(GHSA-qx2v-qp2m-jg93)。維持のみ、
  撤去条件は既記のコメントに従う(新規判断は行わない)。
- 追加: `auditConfig.ignoreGhsas` は**空で導入しない**(必要になった時に R2.3 の書式で追加)。
  runbook に書式例を置く。

### docs/dependency-policy.md(新設 / R1.3, R1.5, R2.4)

advisory 対応 runbook。構成: 検知 → 棚卸し(`pnpm audit --json`)→ 4 段階の対応選択基準 →
検証 → override/ignoreGhsas の撤去条件管理 → `minimumReleaseAge`/`minimumReleaseAgeExclude`
との関係 → Renovate/Dependabot 採否基準(R1.5)。`AGENTS.md` からリンクする。

### .github/workflows/tests.yml(R2.1, R3.2)

- `unit` ジョブから Security Audit ステップを削除し、独立 `audit` ジョブ
  (checkout → mise-action → pnpm-setup → install → `pnpm audit --audit-level=moderate`)を追加。
- `e2e` の `Build` ステップに `NODE_ENV: production` を明示(R3.2)。
- **required-gate 空洞化の防止(R2.2)**: `unit`/`audit`/`e2e` は並列・独立のまま実行し(`unit` に
  `needs: [audit]` は付けない — 付けると audit 失敗時に `unit` 自体が実行されず、R2.1 が
  意図する「audit 赤でもテスト結果が見える」可視性を壊してしまう)。代わりに 3 ジョブすべてに
  `needs: [unit, audit, e2e]` かつ `if: always()` の集約 `gate` ジョブを追加し、
  いずれかの `result` が `success` 以外なら非 0 終了する。
  **重要な前提修正**: `main` の branch protection は 2026-07-24 時点で**存在しない**
  (`gh api repos/:owner/:repo/branches/main/protection` → 404 “Branch not protected”、
  `rulesets` API も空)。つまり「現行の `unit` 単体を置き換える」のではなく、`gate` を
  required check として**新規作成**することが本 spec(タスク 3.2)の完了条件である。
  新規作成できない(権限がない等)場合は、CI ジョブ分離自体は完了していても
  **どのジョブもマージをブロックしていない**状態が継続することを PR 説明に明記する
  (タスク 3.2 の fallback — 「既存 required 設定の一時後退」ではなく「未設定の継続」である
  点を誤解なく記載する)。

### mise.toml(R3.1)

- `[tasks.build]` を `NODE_ENV=production pnpm --filter @vaz/web exec next build` に変更
  (`test:e2e:ollama` が `AI_PROVIDER=ollama` を前置するのと同じインライン env パターン)。

### services/agent(R4.1, R4.2 / NFR-3)

- `app/routes/eval.py:49,67` — `assert judge.last_usage is not None` を
  `if judge.last_usage is None: raise RuntimeError(...)` へ。narrowing が消えるため
  ローカル変数へ代入してから使う(pyright strict 維持)。
- `app/eval/llama.py` `to_token_usage` — 決定確定(gap-analysis で `pydantic_ai.usage.RunUsage`
  に `total_tokens` が実在することを検証済み。`cache_read_tokens`/`cache_write_tokens` も別途公開):
  **provider-reported `usage.total_tokens` を採用**し、docstring に境界定義
  (total は cache/reasoning トークンを含み得るため `input_tokens + output_tokens` と一致しない
  場合がある)を明記する。切替えにより `services/agent/tests/` の既存期待値が
  `input+output` 前提の箇所があれば実測値(cache 0 のケースでは通常一致)に追随させる。

### specs/002-pydantic-enhance(R4.3)

- `spec.md` の Requirement 2(または tasks.md 該当タスク)に
  「Req 2.7b の `traced_span` 配線は Phase E 所管(相関 ID は呼び出し側=nightly runner の持ち物)」
  の追記を 1 段落加える。002 の実装・判定履歴は書き換えない(追記のみ)。

### apps/web/src/app/global-error.tsx(R3.3)

- NOTE コメントを「`mise run build` / CI が `NODE_ENV=production` を強制する」旨へ更新。

## Error Handling & Edge Cases

- **audit ジョブ分離後も 3 ジョブ実質 required**(R2.2): `unit`/`audit`/`e2e` 自体は並列・独立実行を
  維持し(可視性を壊さない)、集約 `gate` ジョブ(上記)を単一の required-check として
  branch protection に**新規作成**することでマージブロックを担保する(現状は required check が
  一切ないため「担保」ではなく「初導入」)。分離の目的は「audit 赤でもテスト結果が見える」
  可視性であり、失格基準の緩和ではない。
- **override の撤去漏れ**: runbook の撤去条件表で管理。`sharp` は next stable が 0.35 系を
  取り込んだ時点(R1.4)、`js-yaml`/`brace-expansion` は `@redocly` 側の範囲更新で自然解消後。
- **ignoreGhsas の恒久化リスク**: 再評価期限を必須とし、期限超過は R2.4 で債務扱い。
- **R4.1 の挙動同値性**: `assert` → `raise RuntimeError` は非 `-O` 実行では同値
  (AssertionError → RuntimeError の型変更のみ)。ハンドラで AssertionError を捕捉している
  箇所がないことを確認する(現状 FastAPI 既定の 500 化で同じ)。

## Constitution Compliance

- 単一正本原則: 依存解決の決定は `pnpm-workspace.yaml`、運用手順は `docs/dependency-policy.md`
  に集約。env による等価設定を作らない(NFR-2)。
- R4.7 プライバシー契約・R5.3 sticky taint への影響なし(本 spec はプロンプト・ツール経路に触れない)。
- モデル ID・埋め込み次元・スキーマ契約に変更なし。

## Requirements Traceability

| Req | 変更ファイル |
| --- | --- |
| 1.1, 1.2 | `apps/web/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`(実施済み) |
| 1.3–1.5, 2.3–2.4 | `docs/dependency-policy.md`(新設), `AGENTS.md`(リンク追記) |
| 2.1–2.2 | `.github/workflows/tests.yml`(`unit`/`audit`/`e2e` 独立 + 集約 `gate` ジョブ)+ branch protection 新規作成(required-check を `gate` に設定 — 現状 required check なし) |
| 3.1 | `mise.toml` |
| 3.2 | `.github/workflows/tests.yml`(e2e Build step) |
| 3.3 | `apps/web/src/app/global-error.tsx` |
| 4.1 | `services/agent/app/routes/eval.py`(+ 既存テスト green) |
| 4.2 | `services/agent/app/eval/llama.py`(+ `tests/` の期待値確認) |
| 4.3 | `specs/002-pydantic-enhance/spec.md`(追記) |
| 5.1–5.3 | 実施記録のみ(`specs/003-.../pdca/`) |
