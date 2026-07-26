# AgentOps ランブック

このリポジトリにおける AgentOps の 3 本柱（可観測性・評価・最適化）が、どのコード・
ワークフローに対応するかを写像する。仕様上の根拠は Req 6.1（`002-pydantic-enhance`）。
未実装の項目は本文書内でその旨を明示し、対応する要件 ID を付す（実装済みであるかのように
描く事故を避ける。`docs/context-budget.md` と同じ方針）。

散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

---

## 1. 可観測性（Observability）

### OTel span

[`apps/web/instrumentation.ts`](../apps/web/instrumentation.ts) の `register()` が
`registerOTel({ serviceName: "vaz-web" })`（`@vercel/otel`）→ `initTelemetry()`
（`@vaz/config/telemetry`）の順で呼ばれる。`registerOTel` が OTel SDK + OTLP exporter を
起動し（`OTEL_EXPORTER_OTLP_*` 未設定時は warn one-shot、fail-soft）、`initTelemetry` が
AI SDK↔OTel のブリッジを登録するため、`streamText`/`generateText` 呼び出しは自動的に span を
発行する。同じ `initTelemetry()` 呼び出しは
[`packages/evals/src/nightly.ts`](../packages/evals/src/nightly.ts) と
[`packages/evals/src/pr-gate.ts`](../packages/evals/src/pr-gate.ts) の CLI エントリポイントにも
存在し、nightly/PR ゲート実行時も span がエクスポートされる。

停止理由（`stop_reason`）は span 属性 `vaz.stop_reason` / `vaz.raw_finish_reason` として
併記される（下記「Req 1.4 metrics」節、`docs/context-budget.md` の該当節と同一の記述を参照）。

### 監査ログ（audit log）

ツール実行の監査は
[`packages/agents/src/audit-hook.ts`](../packages/agents/src/audit-hook.ts) の
`createAuditHook` が AI SDK v7 の `onToolExecutionStart` に一度だけ発火点を持つ
（承認ゲート通過後・`execute` 実行前）。記録するのは
`{ userId, jobId, tool, args, ts }` のみで、`deps.audit` が未設定なら no-op。
Web/worker 両パスとも `deps.logger.error` は correlation フィールドのみを出し、
raw prompt・raw tool args はログに出さない（R4.7 プライバシー契約）。

`AuditSink` の実装は 2 系統ある:

- [`apps/worker/src/audit.ts`](../apps/worker/src/audit.ts) の `createAuditSink` —
  fail-loud（`AuditLogStore.insert` 失敗時は correlation-only でログしてから rethrow）。
- [`apps/web/src/lib/audit.ts`](../apps/web/src/lib/audit.ts) の `createAuditSink` —
  worker 実装（`createWorkerAuditSink`）へ委譲し、process-cached な Postgres クライアントを共有する。

### Req 1.4 metrics（停止理由・トークン監査）

[`packages/schemas/src/run-metrics.ts`](../packages/schemas/src/run-metrics.ts):

- `runStopReasonSchema = z.enum(["natural", "step-cap", "budget-exceeded", "error"])`
  — 閉じた語彙（ADR-A）。
- `runUsageSchema` = `{ inputTokens, outputTokens, totalTokens }`（v7 `usage` 形状）。
- `runMetricsSchema` = `runUsageSchema.extend({ stopReason, stepCount })`。

[`packages/agents/src/stop-reason.ts`](../packages/agents/src/stop-reason.ts) の
`deriveStopReason` が `{ finishReason, totalUsage, steps, budget, maxSteps }` から
優先順位 `error` → `budget-exceeded` → `step-cap` → `natural` でこの語彙を導出する
（フック外の純粋関数、ADR-A）。

[`packages/schemas/src/deps.ts`](../packages/schemas/src/deps.ts) の
`runAuditEntrySchema`（`runMetricsSchema` + `userId`/`jobId`/`ts`）と、対応する
`AuditSink.recordRun?(entry)`（optional — 未実装 sink は no-op、ADR-D）が
「ラン終了ごとに 1 回、集約トークン数のみを記録する」経路。raw prompt / tool args は含まない
（R4.7）。詳細な方針とチャット本線での挙動は `docs/context-budget.md` の
「停止理由の監査（stop_reason）」節を正本とする。

### 未実装（Req 6.1 の可観測性側で未達な部分）

- **ダッシュボードは存在しない。** `recordRun` / audit-hook が書き込むのは Postgres の
  `audit_log` テーブルのみで、その上に可視化を載せる Grafana provisioning・ダッシュボード定義は
  リポジトリ内に一切ない（`docker-compose.yml` の Inngest dev UI は無関係）。
  Langfuse への OTLP エクスポート自体は上記の通り実装済みだが、閾値付きダッシュボードとしての
  運用は未着手 — 次節「最適化」の未実装記述と合わせて Req 6.1 の cost-latency-loop 部分として扱う。

---

## 2. 評価（Evaluation）

[`packages/evals/README.md`](../packages/evals/README.md) が正本。3 段構成 + tier2 の nightly 追加:

- **Tier1**（`packages/evals/src/unit/`）— `MockLanguageModelV4` 駆動、ネットワークゼロ。
  `schema-conformance.spec.ts` / `tool-selection.spec.ts`。
- **Tier2**（[`packages/evals/src/tier2.ts`](../packages/evals/src/tier2.ts)）— RAG の
  `recall@k` ゴールデンセット評価に加え、`services/agent` の `/eval/faithfulness` /
  `/eval/relevancy`（Req 5.2）を per-case で呼ぶ。`AGENT_SERVICE_URL` 未設定時は
  スキップ（fail としない）。tier2 の結果は `regressed` / `hasRegression` / `hasFailure` の
  判定に**寄与しない**（`nightly.ts` の判定は tier3 の judge grade のみで決まる）。
- **Tier3**（[`packages/evals/src/nightly.ts`](../packages/evals/src/nightly.ts) +
  [`packages/evals/src/judge.ts`](../packages/evals/src/judge.ts)）— 実モデルでチャット
  エージェントを `GOLDEN_SET` に対して駆動し、LLM-as-judge（`outcome`/`behavior` の独立軸）で
  採点。[`.github/workflows/eval-nightly.yml`](../.github/workflows/eval-nightly.yml) が
  `workflow_dispatch`（手動のみ — 実モデル課金を抑えるため cron は廃止。日次スロットは
  [`security-daily.yml`](../.github/workflows/security-daily.yml) の依存監査が持つ）で起動、
  `ANTHROPIC_API_KEY` 未設定時は skip（fail しない）。regression / case-failure /
  all-skipped で CI を fail させる。

### Req 5 還流ループ（PR ゲート）

[`.github/workflows/eval-pr.yml`](../.github/workflows/eval-pr.yml)（`on: pull_request`、
ただし **`run-eval` ラベル付き PR のみ** — case ごとに実モデルを呼ぶため opt-in）が
[`packages/evals/src/pr-gate.ts`](../packages/evals/src/pr-gate.ts) の `runPrGate` を実行し、
Req 5.3 の 3 指標を報告する: (1) 直前ベースラインとの pass-rate delta、(2) 新規に
regress/un-regress した case の over/under-trigger balance、(3) case あたりの平均トークン数・
所要時間。ベースラインは GitHub Actions cache（`pr-gate-baseline-*`）で運搬。

`GOLDEN_SET` は現在 **20 件**（`PR_GATE_MIN_CASES_FOR_BLOCKING = 20` と同値）に到達しており、
Req 5.4 の `reportOnly = goldenSetSize < 20` は `false` — 現状のゲートは
regression / case-failure を検出した場合に実際にブロックする（report-only ではない）。

### Doer-Verifier（Req 5.5–5.7）

[`packages/agents/src/supervisor.ts`](../packages/agents/src/supervisor.ts) の
document-generation ステップは opt-in の `verifyDocument?: DocumentVerificationConfig` を持つ
（未設定時は挙動不変）。設定時は必ず機械的チェック（`checkDocumentMechanically` —
非空・citation 参照の存在・HTML/plaintext のフォーマット整合）が先に走り、通過後にのみ
opt-in の `llmVerify`（`/eval/*` 経由の LLM verifier、Doer の会話履歴は渡さない — Req 5.6）が
走る。失敗時は `DocumentVerificationError`（`reason: "error"`、Req 1.4 と同じ閉じた語彙、
Req 5.7）を投げる。

---

## 3. 最適化（Optimization / cost-latency-loop）

`pr-gate.ts` の `computeAverages` が `averageTokens` / `averageDurationMs` を
case あたりで算出し、`PrGateReport` に含めて CI ログへ出力する（Req 5.3 の指標報告そのもの）。
ただし、この数値は**報告のみ**であり、`shouldBlock`（PR ゲートが実際にブロックする条件）は
regression / case-failure だけで決まる — コスト・レイテンシが閾値を超えたことを理由に
ブロックする経路は存在しない。

### 未実装（Req 6.1 の cost-latency-loop 部分）

- **閾値付きの cost-latency ダッシュボードは未実装。** `pr-gate.ts` / `nightly.ts` が算出する
  cost/latency は CI ログとベースライン JSON に出力されるのみで、これを消費する可視化
  （Grafana 等）・閾値アラート・自動チューニングループは本 spec のスコープに含まれていない。
  将来実装する場合は、`docs/context-budget.md` の Stage 0（`recordRun` の実測に基づく
  `CHAT_TOKEN_BUDGET` 見直し）と `pr-gate.ts` の per-case 平均を入力源として想定するのが自然だが、
  これは仕様化されていない拡張であり、着手時は本 spec の Req 5.3 / Req 6.1 を参照して
  スコープを切ること。

---

## 関連

- `docs/context-budget.md` — チャット本線のコンテキスト予算・停止理由監査の詳細（本文書の
  「可観測性」節が参照する正本）。
- `docs/adr/0001-mcp-position.md` — MCP 採用判断（Req 6.2/6.3、Task 12.2）。
- `packages/evals/README.md` — tier1/tier2/tier3 の詳細とゴールデンセットの出自。
- `specs/002-pydantic-enhance/spec.md` Req 1.4/1.5, Req 5, Req 6.1 — 本文書の要件根拠。
