# コンテキスト予算方針（Context Budget Policy）

チャットエージェント（`@vaz/agents` の `createChatAgent`）が 1 リクエストで LLM へ送る
**コンテキスト量**と、エージェントループを**いつ止めるか**の方針を記述する。仕様上の根拠は
Req 1.7（本文書）／Req 1.3・1.4（ループ予算・停止理由）と research.md の ADR-A。

対象は `POST /api/chat` 経由のチャット本線のみ。durable job（supervisor workflow）のコスト方針は
別建て（`packages/agents/src/supervisor.ts`、Req 1.5 の run-metrics）で、本文書の窓化シームは適用しない。

---

## 現行方針（Current policy）

### コンテキスト: 全履歴を送信する

チャット 1 ターンは、クライアントの `UIMessage[]` を
[`convertToModelMessages`](../packages/agents/src/chat-agent.ts) で `ModelMessage[]` に変換し、
**切り詰めなしで丸ごと** `streamText` に渡す（[`chat-agent.ts` の `createChatAgent().stream`](../packages/agents/src/chat-agent.ts)）。
要約・古いメッセージの間引き・トークン上限での truncation は現状**行っていない**。

ステップ間では [`buildPrepareStep`](../packages/agents/src/chat-agent.ts) が働くが、その役割は
RAG の `searchDocuments` 結果を区切り付きコンテキストブロックとして**追記**すること（R5.2）だけで、
既存メッセージの窓化はしない。窓化シーム未指定時、`prepareStep` の戻り値は

- RAG 結果注入なしのステップ: `{}`（＝基底メッセージ集合を変更しない）
- RAG 結果注入ありのステップ: `{ messages: [...messages, contextMessage] }`（追記のみ）

であり、この seam 追加前の挙動と **byte 等価**（Req 1.7）。

### ループ制御: step-count cap ＋ 累積トークン予算（OR）

エージェントループの停止条件は `stopWhen` の**配列**で表現する（OR 意味論、ADR-A）:

```ts
stopWhen: [isStepCount(MAX_STEPS), buildBudgetStopCondition(budget)]
```

| 述語 | 値の出所 | 意味 |
| ---- | -------- | ---- |
| `isStepCount(MAX_STEPS)` | `MAX_STEPS = 5`（`chat-agent.ts` の定数） | ステップ数の上限（安全網） |
| `buildBudgetStopCondition(budget)` | `CHAT_TOKEN_BUDGET`（`@vaz/schemas/env`、default `200_000`） | 累積 input+output トークンが閾値に達したら停止 |

トークン予算述語は、v7 の `StopCondition` に累積 usage が渡されない制約に対応して
`steps[].usage` の `inputTokens + outputTokens` を**自前で合算**する
（`totalTokens` は reasoning トークンを含みうるため使わない。ADR-A）。

**予算はハード上限ではなく「次ステップ抑止」閾値**である。停止判定はステップ完了粒度でしか
起きないため、あるステップの途中で予算を超過しても、そのステップは走り切り、超過は次の述語評価で
捕捉される（近似。ADR-A の Consequences）。`MAX_STEPS` はこの近似に対する安全網として併存する。

### 停止理由の監査（stop_reason）

ラン終了時、[`buildOnEnd`](../packages/agents/src/chat-agent.ts) が
純粋関数 [`deriveStopReason`](../packages/agents/src/stop-reason.ts) で
`{ finishReason, totalUsage, steps }` を閉じた語彙
`runStopReasonSchema = z.enum(["natural","step-cap","budget-exceeded","error"])`
（`@vaz/schemas/run-metrics`）へ写像し、2 か所に記録する（Req 1.4、ADR-A/D）:

- OTel span 属性 `vaz.stop_reason` / `vaz.raw_finish_reason`
- `deps.audit.recordRun`（token 数・stepCount・stopReason のみ。raw プロンプト／tool 引数は出さない。R4.7）

いずれも fail-soft（トレーサ欠如や sink 未実装でランを壊さない。NFR-4）。この記録が、予算・cap の
実測に基づく将来のチューニング（次節）の観測基盤になる。

**5 repo 横断での停止理由語彙（X-5）**: 本 repo の `runStopReasonSchema` は 4 値
（`natural`/`step-cap`/`budget-exceeded`/`error`）だが、Python 側 2 repo
（`pydantic-ai-sandbox`/`fastapi-pydantic-ai-agent`）は `denied`/`disallowed_tool` を含む
5 値を使っており非対称。写像表本体は
[`docs/cross-repo-adoption-backlog.md`](cross-repo-adoption-backlog.md) の X-5 行（および正本の
`vaz-agentic-ai-next/docs/cross-repo-adoption-review.md`）を参照。**今回は統一しない**——
`JobEvent` SSE 契約と `audit_log` の後方互換に影響するため。承認拒否（`denied` 相当）は
この 4 値の外、`ApprovalDeniedError` / supervisor の構造的 duck-typing
（`(error as { reason?: unknown })?.reason`、`packages/agents/src/supervisor.ts`）という
**別経路**で扱われており、`deriveStopReason` の語彙には現れない。

---

## 段階的 compaction（Staged compaction approach）

コンテキスト肥大への対処は、**観測 → opt-in 窓化 → 自動 compaction** の段階で導入する。
現時点で実装済みなのは Stage 0 と、Stage 1 の**シームのみ**（既定は無効）である。

### Stage 0 — 全履歴 + 停止述語（現行・実装済み）

上記「現行方針」そのもの。会話が短い運用では全履歴送信で十分に機能し、コストの上限は
step-cap と `CHAT_TOKEN_BUDGET` で画定される。`deps.audit.recordRun` の run-metrics で
`stop_reason` 分布・トークン消費を観測し、閾値の妥当性を実測で見直す。

### Stage 1 — `prepareStep` 履歴窓化シーム（opt-in・シーム実装済み / 既定は無効）

コンテキストが `CHAT_TOKEN_BUDGET` に頻繁に到達し `budget-exceeded` が支配的になった場合、
呼び出し側が窓化関数を差し込んで**古い履歴を落とす／要約する**。未指定時は byte 等価のため、
有効化は純粋な opt-in（下節の実装詳細を参照）。

### Stage 2 — 自動 compaction（将来）

到達頻度が定常化したら、`prepareStep` 内で会話を**自動要約**して 1 メッセージに畳む
（running summary）等の常時 compaction を検討する。導入時は Req 1.8 と同じく、tier1/tier3 eval の
verdict 変化を before/after で記録してからマージする（Req 5 の還流ループ）。Stage 1 のシームが
そのまま挿し込み口になるため、`buildStreamTextOptions` のシグネチャ追加は不要。

---

## `prepareStep` 履歴窓化シーム（実装詳細）

Req 1.7 の「opt-in history-windowing seam that is byte-equivalent to current behavior when unset」は
以下で実装される。

### API

`CreateChatAgentOptions` に optional な `windowMessages` を追加（[`chat-agent.ts`](../packages/agents/src/chat-agent.ts)）:

```ts
export type WindowMessages = (messages: ModelMessage[]) => ModelMessage[];
```

AI SDK 公式の
[`pruneMessages({ messages, ... })`](../packages/agents/src/chat-agent.ts) ヘルパと同型の引数にしてあり、
呼び出し側はそのヘルパ、または等価な compaction 戦略を直接差し込める:

```ts
createChatAgent(deps, {
  windowMessages: (messages) =>
    pruneMessages({ messages, toolCalls: "before-last-3-messages" }),
});
```

### 適用位置と byte 等価性

`buildPrepareStep(onExternalContext, windowMessages)` は、RAG コンテキストの**追記後**の
メッセージ列に対して**毎ステップ** `windowMessages` を適用する（compaction は注入ステップに
限らず成長し続ける履歴全体に効く必要があるため）。

- `windowMessages` **未指定**（既定）: 現行の追記結果（`{}` または `{ messages: [...messages, contextMessage] }`）を
  そのまま返す ＝ シーム追加前と **byte 等価**（Req 1.7）。
- `windowMessages` **指定時**: `windowMessages(appended)` の結果を `{ messages }` として返し、
  そのステップ以降の基底メッセージ集合を置換する（以降の応答は SDK が追記）。

`prepareStep` の `PrepareStepResult.messages` を返すと「そのステップ以降の基底メッセージ集合を
置換」できる、という v7 の挙動に基づく（research.md 調査 2）。

### RAG 区切りブロック（R5.2）との関係

窓化は R5.2 の untrusted デリミタ注入とは独立に働く。ただし窓化で
`RETRIEVED_CONTEXT_BEGIN`/`END` のブロックがコンテキストからスクロールアウトしても、
承認ポリシー側の sticky taint（`externallyDriven`、R5.3）は一度立つとラン終了まで latch されるため、
窓化によって承認ゲートが**緩むことはない**（`buildStreamTextOptions` の該当コメント参照）。

---

## 関連

- `packages/agents/src/chat-agent.ts` — `MAX_STEPS`・`buildBudgetStopCondition`・`buildPrepareStep`・`WindowMessages`
- `packages/agents/src/stop-reason.ts` — `deriveStopReason`（停止理由導出）
- `packages/schemas/src/env.ts` — `CHAT_TOKEN_BUDGET`
- `packages/schemas/src/run-metrics.ts` — `runStopReasonSchema` / `runMetricsSchema`
- research.md ADR-A（`stopWhen` 配列 + フック外 `stop_reason` 導出）
