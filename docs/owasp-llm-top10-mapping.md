# OWASP Top 10 for LLM Applications 対応表

[`OWASP Top 10 for LLM Applications`](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
（LLM01〜LLM10）の各行に本 repo の実装コードとそれを検証するテストを引用する。5 repo
横断レビュー X-13 の受け入れ条件（`docs/cross-repo-adoption-backlog.md`）どおり、
「対応している」という主張はテストの引用を伴わない限り書かない。対応がない行は
「未対応」と明記する（実装済みであるかのように描く事故を避ける方針は
`docs/agentops.md` / `docs/context-budget.md` と同じ）。

参照実装: `fastapi-pydantic-ai-agent/docs/owasp-agentic-llm-mapping.md`（全行にテスト引用がある形式）。
Agentic AI 特有の脅威（マルチステップ自律実行・ツール連鎖など）は本表の対象外——
[`docs/owasp-agentic-ai-top10-mapping.md`](owasp-agentic-ai-top10-mapping.md) を参照。

散文は日本語、識別子・型・パス・コードは英語。

---

## LLM01: Prompt Injection

RAG 検索結果は明示的なデリミタ（`RETRIEVED_CONTEXT_BEGIN`/`_END`）で囲み、
「参照データであり指示ではない」と明記した上で `user`-role メッセージに載せる
（`system` prompt には決して連結しない）。デリミタ文字列自体がチャンク本文に含まれていても
偽の閉じタグとして機能しないようエスケープする。

- 実装: [`packages/agents/src/prompt.ts`](../packages/agents/src/prompt.ts)
- テスト: `packages/agents/tests/prompt.spec.ts`

注入されたコンテンツが会話に一度でも混入すると、`externallyDriven` フラグがラン終了まで
sticky に立ち、承認可能ツールは述語の戻り値に関わらず強制的に `'user-approval'` になる
（デリミタがコンテキスト窓から外れても効果が持続する。R5.3）。

- 実装: [`packages/agents/src/approval-policy.ts`](../packages/agents/src/approval-policy.ts)
  の `isExternallyDrivenTurn`
- テスト: `packages/agents/tests/approval-policy.spec.ts`

## LLM02: Sensitive Information Disclosure

`Logger.info/warn/error` は raw user prompt・raw tool 入出力を `fields` に含めてはならない
（R4.7 プライバシー契約）。監査ログ（`deps.audit`）が tool 引数を記録する唯一の許可された
場所で、通常ログには識別子（`messageId` 等）のみを出す。

- 実装: [`packages/agents/src/audit-hook.ts`](../packages/agents/src/audit-hook.ts)、
  [`packages/config/src/logger.ts`](../packages/config/src/logger.ts)
- テスト: `packages/agents/tests/audit-hook.spec.ts`、`packages/schemas/tests/deps.spec.ts`

## LLM03: Supply Chain

pnpm ワークスペースは `minimumReleaseAge: 1440`（公開 24 時間未満のバージョンを解決しない）
と `allowBuilds`（install script を持つ新規依存は明示的に `true`/`false` を記録しない限り
`pnpm install` が失敗する）の 2 段ゲートを持つ。advisory 対応手順は
`docs/dependency-policy.md` に runbook 化されている。

- 実装: [`pnpm-workspace.yaml`](../pnpm-workspace.yaml)
- テスト: `.github/workflows/security-daily.yml`（`pnpm audit --audit-level=moderate`、毎日実行）

GitHub Actions は全 6 ワークフローの `uses:` を 40 桁コミット SHA に固定し、各ワークフローが
最小権限の `permissions:` を宣言する（X-1、本表とは別の CI サプライチェーン統制）。

- 実装: [`.github/workflows/`](../.github/workflows/)
- テスト: `tests/repo/ci-workflows.spec.ts`

## LLM04: Data and Model Poisoning

モデル ID は `@vaz/config/model-allowlist.ts`（と `@vaz/schemas/src/env.ts` の Zod default）
にのみハードコードを許可し、`scripts/forbid-model-ids.sh` の grep ゲートが他の場所への
記述を機械的に拒否する（意図しないモデル切り替えの防止）。

- 実装: [`packages/config/src/model-allowlist.ts`](../packages/config/src/model-allowlist.ts)、
  [`scripts/forbid-model-ids.sh`](../scripts/forbid-model-ids.sh)
- テスト: `packages/config/tests/model-allowlist.spec.ts`、
  `.github/workflows/lint.yml`（`Model-ID gate` ステップ、モデル文字列混入時に fail）

RAG コーパスへの埋め込みは provider/model/dim が既存コーパスと異なる場合に書き込みを拒否する
（供給源の異なる埋め込みが同一コーパスに混在するのを防ぐ）。

- 実装: [`packages/rag/src/ingest/index.ts`](../packages/rag/src/ingest/index.ts) の
  `assertNoProviderMixing`
- テスト: `packages/rag/tests/ingest.spec.ts`

## LLM05: Improper Output Handling

チャット UI（`apps/web/src/features/chat/Chat.tsx`）はモデル出力を `dangerouslySetInnerHTML`
等でレンダリングしない（React の標準テキストレンダリングのみ）。モデル出力を shell コマンドや
SQL に直接連結する経路は存在しない——ツール実行は `inputSchema`（Zod）でバリデーションされた
構造化引数のみを受け取る。

- 実装: `apps/web/src/features/chat/Chat.tsx`（`grep -rn dangerouslySetInnerHTML apps/web/src` が 0 件）
- テスト: 専用テストなし——**未対応**。回帰時に検知する grep ガードの追加は本表のスコープ外
  （X-13 の受け入れ条件どおり「実装は不要」の項目ではないが、今回のバックログには含まれていない）。

## LLM06: Excessive Agency

破壊的ツール（`sendEmail`）は `needsApproval: true` の宣言（`@vaz/tools`）と、それを読んで
`'user-approval'` を返す決定ロジック（`@vaz/agents`）を分離し(OWNERSHIP SPLIT)、
さらに宛先の許可リスト（`RECIPIENT_ALLOWLIST`、committed・空初期値）という独立した第 2 ゲートを
持つ(Rule of Two)。承認ゲートを通過しても許可リスト外の宛先には配送できない。

- 実装: [`packages/agents/src/approval-policy.ts`](../packages/agents/src/approval-policy.ts)、
  [`packages/tools/src/allowlist.ts`](../packages/tools/src/allowlist.ts)
- テスト: `packages/agents/tests/approval-policy.spec.ts`、`packages/tools/tests/allowlist.spec.ts`

管理者ロールも同じ統治パターン（`ADMIN_EMAILS`、committed・空初期値）で、IdP claim を信用せず
アプリ側の allow-list からのみ解決する。

- 実装: [`packages/config/src/role-allowlist.ts`](../packages/config/src/role-allowlist.ts)
- テスト: `packages/config/tests/role-allowlist.spec.ts`

## LLM07: System Prompt Leakage

`CHAT_SYSTEM_PROMPT`（`packages/agents/src/prompt.ts`）は秘密情報（API キー、内部 URL 等）を
一切含まない設計だが、system prompt 自体の漏洩を防ぐ明示的な対策（プロンプト抽出攻撃への防御、
出力フィルタ等）は実装していない。

- テスト: なし——**未対応**。

## LLM08: Vector and Embedding Weaknesses

埋め込み次元は DDL で 768 に固定（`EMBEDDING_DIM`）されており、異なる次元・provider の
埋め込みが同一コーパスに混在することを LLM04 の `assertNoProviderMixing` が防ぐ
（ベクトル空間の汚染・非互換化への対策としても機能する）。取り込み対象は `.md`/`.mdx`/`.txt`
（または `--via-parser` 経由で Docling が扱える形式）に限られ、任意コードを埋め込む経路はない。

- 実装: [`packages/db/src/schema.ts`](../packages/db/src/schema.ts)（`EMBEDDING_DIM`）、
  [`packages/rag/src/ingest/index.ts`](../packages/rag/src/ingest/index.ts)
- テスト: `packages/db/tests/schema-ddl.spec.ts`、`packages/rag/tests/ingest.spec.ts`

## LLM09: Misinformation

Tier2 eval（faithfulness/relevancy）が golden set の各ケースについて、モデル回答が
検索結果・ツール出力に対して忠実か／関連しているかを LLM judge（`services/agent`）で
検証し、nightly / PR ゲート（`run-eval` ラベル時）で継続的に測定する。

- 実装: [`packages/evals/src/tier2.ts`](../packages/evals/src/tier2.ts)
- テスト: `packages/evals/tests/tier2.spec.ts`、
  `.github/workflows/eval-nightly.yml` / `.github/workflows/eval-pr.yml`

回答中の引用は `[source#ordinal]` 形式で `searchDocuments` が返した実際のソース・順序と
一致させるよう system prompt で指示している(出典の検証可能性)。

- 実装: `CHAT_SYSTEM_PROMPT`（`packages/agents/src/prompt.ts`）
- テスト: `packages/agents/tests/chat-agent.spec.ts`（引用フォーマットのアサーション）

## LLM10: Unbounded Consumption

チャットは `stopWhen: [isStepCount(MAX_STEPS), buildBudgetStopCondition(budget)]` で
ステップ数とトークン予算の両方に上限を持つ（`docs/context-budget.md` Stage 0)。
Nightly eval にはコストキャップ（`EVAL_NIGHTLY_COST_CAP_TOKENS`）があり、超過を検知して
非ゼロ終了する。CI 側は全ジョブに `timeout-minutes` を設定している。

- 実装: [`packages/agents/src/chat-agent.ts`](../packages/agents/src/chat-agent.ts)
- テスト: `packages/agents/tests/chat-agent.spec.ts`、`packages/evals/tests/nightly.spec.ts`
