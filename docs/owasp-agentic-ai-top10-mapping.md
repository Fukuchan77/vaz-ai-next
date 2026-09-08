# OWASP Agentic AI 脅威分類 対応表(レイヤ別)

OWASP GenAI Security Project の [`Agentic AI – Threats and Mitigations`](https://genai.owasp.org/)
が挙げるエージェント固有の脅威のうち、本 repo のアーキテクチャに実際に該当するものを
レイヤ別(入力/計画/メモリ/ツール実行/アイデンティティ/オーケストレーション/人間監督)に
整理し、実装コードとテストを引用する。5 repo 横断レビュー X-13 の受け入れ条件
(`docs/cross-repo-adoption-backlog.md`)どおり、対応の主張には必ずテストを引用し、
対応がない項目は「未対応」と明記する。

対象タクソノミは [`docs/owasp-llm-top10-mapping.md`](owasp-llm-top10-mapping.md)
(OWASP Top 10 for LLM Applications、LLM01〜LLM10)と重複しない——あちらは単発の
プロンプト/出力/サプライチェーンの脅威、本表は「複数ステップの自律実行」
「ツール連鎖」「人間監督の破綻」といったエージェント特有の脅威を対象にする。

参照実装: `pydantic-ai-sandbox/patterns/SECURITY-NOTES.md`(Agentic AI 脅威をレイヤ別に
整理する形式)。

散文は日本語、識別子・型・パス・コードは英語。

---

## 入力/計画レイヤ — Intent Breaking & Goal Manipulation

RAG 検索結果に埋め込まれた指示が、複数ステップのラン(chat の tool loop、supervisor の
複数 specialist 呼び出し)の途中でエージェントの目的を書き換えようとする攻撃。
`externallyDriven` は一度立つとラン終了まで sticky で、supervisor の複数ステップに
またがっても有効(1 ステップだけの防御ではない)。

- 実装: [`packages/agents/src/approval-policy.ts`](../packages/agents/src/approval-policy.ts)
- テスト: `packages/agents/tests/approval-policy.spec.ts`

## メモリ/RAG レイヤ — Memory Poisoning

本 repo は長期の会話メモリストアを持たない(ステートレス、リクエストごとに履歴を渡す。
Stage 0)ため、古典的な「エージェントの長期記憶に汚染データを埋め込む」攻撃面は狭い。
残る面は RAG コーパスの汚染で、provider/model/dim が異なる埋め込みの混入を拒否する
`assertNoProviderMixing` が該当する(LLM04/LLM08 と同じ実装)。

- 実装: [`packages/rag/src/ingest/index.ts`](../packages/rag/src/ingest/index.ts)
- テスト: `packages/rag/tests/ingest.spec.ts`

## ツール実行レイヤ — Tool Misuse

破壊的ツール(`sendEmail`)は HITL 承認ゲート(`needsApproval` → `'user-approval'`)と
宛先許可リスト(`RECIPIENT_ALLOWLIST`)という独立した 2 段の統制を持つ(Rule of Two)。
承認された呼び出しであっても許可リスト外の宛先には配送できない。

- 実装: [`packages/agents/src/approval-policy.ts`](../packages/agents/src/approval-policy.ts)、
  [`packages/tools/src/allowlist.ts`](../packages/tools/src/allowlist.ts)
- テスト: `packages/agents/tests/approval-policy.spec.ts`、`packages/tools/tests/allowlist.spec.ts`

Supervisor が承認拒否を検知した際は、続く specialist を呼び出さずランを打ち切る
(拒否後に別の手段でツールを使い続けようとしない)。

- 実装: [`packages/agents/src/supervisor.ts`](../packages/agents/src/supervisor.ts)
  (`ApprovalDeniedError` の構造的 duck-typing)
- テスト: `packages/agents/tests/supervisor.spec.ts`

## アイデンティティ/アクセスレイヤ — Privilege Compromise

エージェントの `runtimeContext`(`{ userId, role }`)は IdP の claim を直接信用せず、
サーバ側で認証済みメールを committed allow-list(`ADMIN_EMAILS`)に照合して解決する。
ツール実行がこの `role` を tool 引数経由で上書きする経路は存在しない。

- 実装: [`apps/web/src/lib/auth.ts`](../apps/web/src/lib/auth.ts)、
  [`packages/config/src/role-allowlist.ts`](../packages/config/src/role-allowlist.ts)
- テスト: `apps/web/tests/auth.spec.ts`、`packages/config/tests/role-allowlist.spec.ts`

## アイデンティティ/アクセスレイヤ — Identity Spoofing & Impersonation

チャット・ジョブ API は Auth.js(OIDC)セッションからのみ `userId`/`role` を導出し、
ジョブ承認 API(`POST /api/jobs/:id/approve`)は `findJobOwnerUserId` でジョブ所有者と
呼び出し元セッションを突き合わせる(他ユーザーのジョブを承認/拒否できない)。

- 実装: [`apps/web/src/lib/jobs.ts`](../apps/web/src/lib/jobs.ts)
- テスト: `apps/web/tests/jobs.spec.ts`

## オーケストレーション/リソースレイヤ — Resource Overload(Unbounded Consumption)

Chat は `stopWhen: [isStepCount(MAX_STEPS), buildBudgetStopCondition(budget)]` で
ステップ数・トークン予算の双方に上限を持つ(`docs/context-budget.md` Stage 0)。
Supervisor 側にも specialist 呼び出しの構造的な段数制限があり、無限ループへ
自律的に発散しない。

- 実装: [`packages/agents/src/chat-agent.ts`](../packages/agents/src/chat-agent.ts)
- テスト: `packages/agents/tests/chat-agent.spec.ts`

## オーケストレーション/データレイヤ — Cascading Hallucination

`rag-research` ステップの `citations` は自動的に後続の `document-generation` ステップへ
引き継がれる(citation handoff)。これにより、途中ステップで得た根拠が後続ステップで
再度モデルにより「捏造」されるのではなく、検証可能な形で機械的に伝播する。
生成ドキュメントの検証(`RunStopReason` の閉じた語彙)も、想定外の完了状態を
「成功」として扱わない設計になっている。

- 実装: [`packages/agents/src/supervisor.ts`](../packages/agents/src/supervisor.ts)
- テスト: `packages/agents/tests/supervisor.spec.ts`

Tier2 eval(faithfulness/relevancy)が、最終回答が根拠(ツール出力・検索結果)に忠実かを
継続的に測定し、モデル/プロンプト変更による劣化を検知する(nightly / PR ゲート)。

- 実装: [`packages/evals/src/tier2.ts`](../packages/evals/src/tier2.ts)
- テスト: `packages/evals/tests/tier2.spec.ts`

## 人間監督レイヤ — Repudiation & Untraceability

すべてのツール実行(承認ゲート通過後・`execute` 直前)が単一の発火点で監査ログに
記録される(web/worker 両パスを1 箇所のロジックが覆う)。「どのユーザーの、どのジョブの、
どのツール呼び出しか」を後から追跡できる。

- 実装: [`packages/agents/src/audit-hook.ts`](../packages/agents/src/audit-hook.ts)
- テスト: `packages/agents/tests/audit-hook.spec.ts`

## 人間監督レイヤ — Overwhelming Human-in-the-Loop

承認要求は `needsApproval: true` を宣言したツール(現状 `sendEmail` のみ)に限定され、
読み取り専用ツール(`searchDocuments`/`getCurrentTime`)は承認を要求しない設計により、
承認疲れ(過剰な承認要求で人間監督が形骸化する攻撃面)を最小化している。ただし
「承認要求のレート制限」や「同一ユーザーへの短時間大量承認要求の検知」のような
能動的な対策は実装していない。

- 実装: [`packages/agents/src/approval-policy.ts`](../packages/agents/src/approval-policy.ts)
  (`isApprovalCapable` — `needsApproval` 宣言ツールのみが対象)
- テスト: `packages/agents/tests/approval-policy.spec.ts`
- 未対応: 承認要求のレート制限・大量発生の検知

## 未対応 — Misaligned & Deceptive Behaviors

エージェントが与えられた目的から逸脱した「偽装的に協調的な」振る舞いをする(目的を
達成したように見せかけて実際には別の行動を取る等)脅威に対する専用の検知機構はない。
Tier2 eval のスコア低下が間接的なシグナルにはなり得るが、この脅威を名指しして
検証するテストは存在しない。

- テスト: なし——**未対応**。
