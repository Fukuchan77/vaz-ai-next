# Phase 3 スパイク — 耐久ワークフローエンジン確定（Inngest vs Temporal TS SDK）

> **Status**: ✅ Decided — **Inngest（TS SDK / self-hosted）を採用**
> **Resolves**: ADR-2 / Clarification Q2（`spec.md`）/ Task 11.1
> **Requirements**: R3.2（主）, R3.4, R3.5, R3.6, R3.7, R3.8
> **Date**: 2026-07-06

散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

---

## 1. 目的とスコープ

Phase 3 は「HTTP タイムアウトに縛られない長時間ジョブを `apps/worker` で耐久実行し、
破壊的ツールを承認待ちで中断→（翌日でも）再開する」を成立させる（R3）。設計（`plan.md`
ADR-2）は責務を次のように分割済み:

- **AI SDK 7** = 型付き合成（supervisor→specialist の handoff）＋承認 *契約*（`needsApproval` /
  `tool-approval-request`）。**in-process** であり、プロセス再起動・多日中断は跨げない（`research.md`
  L91–103 で検証済み）。
- **外部耐久エンジン** = 制御フローの耐久実行、チェックポイント、承認待ち中断→再開、再起動跨ぎ完走。

本スパイクは、この「外部耐久エンジン」を **Inngest** と **Temporal (TS SDK)** の 2 候補で
**実装レベルに比較**し、確定する（Q2）。

### 手法（honest scope）

本環境は Task 8.1 から継続の FLAG（Docker image-pull 不可・外部到達不可）により、2 エンジンを
**同時に本番構成で立ち上げた running PoC** は取れない。したがって本スパイクは
**「現行公式ドキュメント + SDK ソース + `research.md` を根拠にした実装マッピング比較」** として実施する
（各軸を両エンジンの一次プリミティブへ写像し、コードスケッチと運用フットプリントで判定）。
根拠は §9 に列挙。この粒度は Task 11.1 の要求（「実装比較（中断/再開・HITL・再起動跨ぎ）と
エンジン確定結論を記録する」）を満たす。実 PoC 実測は 8.1 FLAG 解消後の Task 12〜14 実装で兼ねる。

---

## 2. 受入基準 → 各軸が要求する耐久能力

| AC | 要求 | 判定軸 |
| --- | --- | --- |
| R3.2 | 耐久エンジンが制御フローを駆動 / web(投入) ↔ worker(実行) を分離 | 軸 C（分離モデル） |
| R3.4 | 破壊的ツールで中断し承認 UI（approve/reject/edit）を提示 | 軸 A（中断/再開・HITL） |
| R3.5 | 承認イベント受信でチェックポイントから再開 | 軸 A |
| R3.6 | 進捗イベント（step-start/tool-call/token/completion/error）を永続化し SSE 配信 | 軸 D（イベント/可観測性） |
| R3.7 | 10 分超のジョブが **worker 再起動を跨いで完走** | 軸 B（再起動跨ぎ耐久） |
| R3.8 | 承認待ち中断→**翌日承認→再開完走** の E2E が通る | 軸 A + 軸 B |

---

## 3. 軸 A — 中断/再開・HITL（R3.4 / R3.5 / R3.8）

VAZ の中核要件。「破壊的ツール実行前に中断し、外部の承認イベント（数分〜数日後）で再開する」を、
どれだけ薄く・確実に表現できるか。

### Inngest — `step.waitForEvent()`

承認待ちは **first-class**。`match` で相関キー（`jobId`）を束ね、`timeout` で承認期限（例 `"7d"`）を
宣言するだけで、その間ワークフローは **サーバ側で耐久 suspend** される。

```typescript
// apps/worker: durable function
export const runJob = inngest.createFunction(
  { id: "run-job", retries: 3 },
  { event: "job/requested" },
  async ({ event, step }) => {
    const plan = await step.run("plan", () => supervisor.plan(event.data));

    // 破壊的ステップの手前で承認待ち。ここでプロセスが落ちても状態はサーバに残る。
    const approval = await step.waitForEvent("await-approval", {
      event: "job/approval.granted",
      match: "data.jobId",     // job/requested の jobId と相関
      timeout: "7d",           // 翌日承認でも OK（R3.8）
    });
    if (!approval) return { status: "expired" }; // timeout → null

    return step.run("send-email", () => emailTool.execute(plan.args)); // 破壊的
  },
);

// apps/web: 承認 UI から
await inngest.send({ name: "job/approval.granted", data: { jobId } });
```

- **R3.5**（checkpoint 再開）: `waitForEvent` の前に完了した `step.run` は memoize 済み。再開時に
  再実行されない（副作用の二重発火なし）。
- **R3.8**（翌日承認）: `timeout` の範囲内なら中断は日跨ぎで持続。承認イベント到着で即再開。
- **HITL 実例**: `examples/realtime/realtime-human-in-the-loop`（`step.waitForEvent` + Realtime
  publish/subscribe）が公式に存在（§9）。

### Temporal — Signal + `condition()`

承認は **Signal**（外部→ワークフローへの非同期入力）と `condition()`（述語成立まで durable await）で表現。
公式 `contrib/openai-agents` は AI SDK 相当の `needsApproval` 割り込みを Signal で解決し、
`continueAsNew` で run state を保持する実装を示す（§9）。

```typescript
import { condition, defineSignal, setHandler, sleep } from "@temporalio/workflow";
const approveSignal = defineSignal<[boolean]>("approve");

export async function runJob(input: JobInput): Promise<JobResult> {
  const plan = await planActivity(input);            // Activity = 副作用境界

  let decision: boolean | undefined;
  setHandler(approveSignal, (ok) => { decision = ok; });

  // 述語成立 or timeout まで耐久 await（7 日）。
  const got = await condition(() => decision !== undefined, "7 days");
  if (!got || decision === false) return { status: "rejected" };

  return sendEmailActivity(plan.args);               // 破壊的
}

// apps/web: client から
await client.workflow.getHandle(workflowId).signal(approveSignal, true);
```

- 同等の耐久 suspend/resume は得られるが、**boilerplate が多い**（Signal 定義・handler 登録・
  述語管理）。かつ workflow コードは **determinism 制約**（`Date.now()`/`Math.random()`/直接 I/O 禁止、
  副作用は Activity へ隔離）を厳守する必要がある。

**軸 A 判定**: **Inngest 優位**。`waitForEvent` が「相関付き・期限付き・日跨ぎ中断→イベント再開」を
1 プリミティブで表現し、R3.4/3.5/3.8 に最短で写像する。Temporal も充足するが記述量と規約負荷が高い。

---

## 4. 軸 B — 再起動跨ぎ耐久（R3.7）

「10 分超ジョブが worker 再起動を跨いで完走する」。**両エンジンとも構造的に充足**する（これが両者を
BullMQ 単体より優先する理由 — `research.md` L152–155）。

| | 耐久メカニズム | 再起動後の挙動 |
| --- | --- | --- |
| **Inngest** | step 出力をサーバが永続化（本番 = Postgres/Redis backend）。関数は再 invoke され、完了 step は memoize され再実行されない。 | 未完 step から継続。長時間 `sleep`/`sleepUntil`/`waitForEvent` はプロセス非依存でサーバ側に保持。 |
| **Temporal** | Event-sourced history。workflow は決定論的 replay で再構築、Activity 結果は history から復元。 | 履歴を replay して中断点から継続。極めて強い保証（金融級実績）。 |

**軸 B 判定**: **引き分け（両者充足）**。保証の *強度* は Temporal がやや上（厳密な event-sourcing +
replay）。ただし R3.7 の要求（10 分超・再起動跨ぎ完走）は Inngest の永続 step モデルで十分に満たす。

---

## 5. 軸 C — web↔worker 分離（R3.2）

「投入（`apps/web`）と実行（`apps/worker`）を decouple する」。

- **Inngest（event-driven）**: web は `inngest.send({ name: "job/requested", data })` で **イベント投入**
  のみ。Inngest サーバが耐久エンキュー → worker の関数を起動。`POST /api/jobs` → `send` の 1 行で分離が
  成立し、11.2 の `JobEvent` 判別共用体を **そのままイベント名/ペイロードに写像**できる（後述 §8）。
- **Temporal（task-queue）**: web は Client として `client.workflow.start(runJob, { taskQueue, workflowId })`。
  worker は task queue を **poll** して実行。これも自然に分離するが、Client 接続（gRPC）と workflowId 採番の
  取り回しが要る。

**軸 C 判定**: **Inngest 優位（僅差）**。イベント投入モデルが VAZ の「型付きイベント union」設計（11.2/R3.6）と
同型で、`@vaz/schemas/workflows.ts` の契約が投入・進捗・承認の全経路で一貫する。

---

## 6. 軸 D — 進捗イベントと可観測性（R3.6 / R4）

- **Inngest**: `Realtime`（`inngest.realtime.publish` / `subscribe`）が typed message stream を提供し、
  SSE Route Handler + `useJobStream` に直結（R3.6）。`/metrics`（Prometheus）も server が公開。step 単位の
  自動リトライ/可観測性がダッシュボードに出る。
- **Temporal**: 進捗は Query か外部 side-channel（DB/Redis pub-sub）で表現するのが定石。設計は元々
  「DB または Redis pub/sub に永続化して SSE」を想定（R3.6）しており **どちらでも実装可**。Temporal Web UI は
  workflow/activity の履歴可視化が強力。

**軸 D 判定**: **Inngest 僅差優位**（Realtime が SSE 要件に直結）。ただし決定的差ではない
（VAZ は OTel→Langfuse を別途持つ、R4.1）。

---

## 7. 運用フットプリント（self-hosting）— 決定的軸

内部業務ツール規模での **運用コスト**。ここが最終判断を分ける。

| | Inngest（self-hosted） | Temporal（self-hosted cluster） |
| --- | --- | --- |
| コアサービス | **単一バイナリ**（全 service 同梱、`inngest start` / Docker） | Frontend / History / Matching / Worker の **複数 service クラスタ** |
| 永続ストア | 本番 = **Postgres**（`INNGEST_POSTGRES_URI`）+ Redis（`INNGEST_REDIS_URI`） | Cassandra / **PostgreSQL** / MySQL のいずれか + 高度 visibility に Elasticsearch/OpenSearch |
| デプロイ補助 | docker-compose 例 + 公式 **Helm chart**（KEDA autoscale, K8s 1.20+） | docker-compose（dev）/ Helm / 手動。本番は multi-service 運用 |
| worker 接続 | HTTP `serve` **または Connect（WebSocket gateway :8289）** — worker が inbound HTTP を晒さず常駐可 | task queue を **poll**（gRPC）。常駐 worker と自然に整合 |
| dev 体験 | `inngest dev`（in-memory/SQLite, ゼロ依存） | `temporal server start-dev`（単一バイナリ, ゼロ依存） |
| 学習/規約負荷 | 低（TS-first, event/step のみ） | 高（**determinism 制約**・versioning/patching・replay 規律） |

**要点**: VAZ は **Phase 2 で既に Postgres（pgvector）を運用**している。Inngest はその Postgres + Redis を
足すだけで本番自己ホストが成立し、Connect により `apps/worker` を「inbound HTTP を持たない純常駐プロセス」
（R3.1 の像）として動かせる。Temporal は multi-service クラスタ + 専用永続 DB + （実用上）ES/OpenSearch を
別立てで運用し、workflow コードに determinism 規約を課す — **内部ツール規模には過剰**。

---

## 8. VAZ アーキ整合と 11.2 への写像

- **「薄くラップ」原則（ADR-2）**: Inngest の event/step モデルは AI SDK の型付き合成の *外側* に
  最小限で乗り、AI SDK が持たない「耐久・中断/再開」だけを補う。責務分割が綺麗に閉じる。
- **`JobEvent` 判別共用体（11.2 / R3.6）**: Inngest の event 名前空間へ直接写像できる
  （`job/requested` → `step-start`/`tool-call`/`token`/`completion`/`error` を Realtime topic として publish）。
  Task 11.2 の `packages/schemas/src/workflows.ts` は **エンジン非依存の Zod 契約**として定義し、Inngest の
  `EventSchemas.fromZod(...)` で型注入する想定（11.2 はエンジン API を import しない — leaf 規律を維持）。
- **determinism と ADR-3 の親和**: Temporal の「workflow 内で `new Date()` 禁止」は VAZ の `deps.now(): Clock`
  規律（ADR-3）と思想が一致し魅力的だが、その規律は VAZ 側で既に担保済み。エンジンにまで同種の制約を
  持ち込む必然はない。

---

## 9. 決定 — Inngest（TS SDK / self-hosted）

### 結論

Phase 3 の耐久ワークフローエンジンは **Inngest（TS SDK, self-hosted: Postgres + Redis）** を採用する。
`apps/worker` は Inngest の **Connect（WebSocket）** で常駐し、`apps/web` は `inngest.send()` で投入のみ行う。

### 根拠（優先順）

1. **HITL 中断/再開が最短（軸 A / R3.4-3.5-3.8）** — `step.waitForEvent({ match, timeout: "7d" })` が
   「相関付き・期限付き・日跨ぎ中断→イベント再開」を 1 プリミティブで表現。VAZ の中核ユースケースに直写像。
2. **web↔worker 分離が event でタダ（軸 C / R3.2）** — 投入・進捗・承認の全経路が 11.2 の Zod イベント union と
   同型になり、契約が一貫する。
3. **運用フットプリントが要件に比例（§7）** — 既存 Postgres + Redis + 単一バイナリ + Connect。Temporal の
   multi-service クラスタ + determinism 規約は内部ツール規模に過剰。
4. **TS-first / 薄いラップ（ADR-2）** — 学習・規約負荷が低く、AI SDK の型付き合成の外側に最小で乗る。
5. **再起動跨ぎ完走（軸 B / R3.7）を構造的に充足** — 永続 step + memoize。

### 却下理由（Temporal）

耐久保証の *強度* とスケール実績は Temporal が上。しかし (a) 承認フローの記述量・(b) determinism/patching の
規約負荷・(c) multi-service クラスタ + 専用永続ストアの運用コストが、VAZ の要件規模に対して不釣り合い。
**強い理由がない限り採らない**（過剰設計の回避 = ADR-2 の「車輪の再発明を避ける」の裏返し）。

### 受入基準 → 採用プリミティブ 対応表

| AC | Inngest プリミティブ |
| --- | --- |
| R3.2 | `inngest.send()`（web 投入）＋ Connect worker（実行）で decouple |
| R3.4 | 破壊的 step 手前の `step.waitForEvent`；承認 UI は `job/approval.*` イベントを送出 |
| R3.5 | `waitForEvent` 前の `step.run` は memoize → checkpoint 再開で二重発火なし |
| R3.6 | `Realtime` publish（step-start/tool-call/token/completion/error）→ SSE + `useJobStream` |
| R3.7 | 永続 step backend（Postgres/Redis）で再起動跨ぎ継続 |
| R3.8 | `waitForEvent({ timeout: "7d" })` の日跨ぎ suspend → 翌日イベントで resume（E2E 対象） |

---

## 10. リスクと軽減 / 撤退基準

- **リスク: self-hosted Inngest の運用習熟** → 軽減: dev は `inngest dev`（ゼロ依存）、本番は公式 Helm/
  docker-compose を踏襲。`/metrics`（Prometheus）で監視。
- **リスク: Connect（WS）gateway の可用性** → 軽減: HTTP `serve` へフォールバック可能（同一関数定義）。
- **リスク: エンジンロックイン** → 軽減: 11.2 の `workflows.ts` を **エンジン非依存の Zod 契約**として定義し、
  supervisor/step I/O をエンジン API から分離（Temporal へ差し替える場合も契約は不変）。
- **撤退基準（Temporal 再評価トリガ）**: (a) 単一 workflow が数千 step / 数週間常駐に達する、(b) 厳密な
  event-sourcing 監査が規制要件になる、(c) 多言語 worker が必要になる — いずれかが現実になった時点で再評価。

---

## 11. 次アクション（Task 11.2 以降への申し送り）

- **11.2**: `packages/schemas/src/workflows.ts` に supervisor→specialist の step I/O Zod スキーマと
  `JobEvent` 判別共用体を **エンジン非依存**で定義（Inngest API は import しない = schemas leaf 規律）。
- **12.x**: `createSupervisorWorkflow(deps)` を Inngest `createFunction` の step 群として実装、
  `toolApproval` ポリシー中断を `step.waitForEvent` に接続。
- **13/14.x**: `apps/worker`（Connect 常駐）+ Dockerfile/compose、`POST /api/jobs`→`inngest.send`、
  SSE Route Handler + `useJobStream`（Realtime 購読）。実 PoC 実測（R3.7/3.8 E2E）は 8.1 FLAG 解消環境で兼ねる。

---

## 12. 根拠（Evidence）

- Inngest step primitives（`step.run`/`sleep`/`sleepUntil`/`waitForEvent`/`sendEvent`/`invoke`/`ai.wrap`）:
  `inngest-js` `packages/inngest/CLAUDE.md`（Available Step Tools / Creating Functions）。
- Inngest HITL 実例: `inngest-js` `examples/realtime/realtime-human-in-the-loop`（`waitForEvent` + Realtime）。
- Inngest 耐久性/クラッシュ復旧: `inngest-js` `examples/durable-endpoints-deepresearch`（crash recovery /
  resume from last successful step）。
- Inngest self-hosting: 公式 `inngest.com/docs/self-hosting`（単一バイナリ / Postgres + Redis / Connect
  gateway :8289 / Helm / docker-compose / `/metrics`）。
- Temporal HITL（Signal + `condition` + `continueAsNew`）: `sdk-typescript`
  `contrib/openai-agents/README.md`（approval workflow）; workflow 内 `condition`/`setHandler`/`defineSignal`。
- Temporal 決定論 replay: `sdk-typescript` `packages/workflow/src/worker-interface.ts`
  （activation / `tryUnblockConditions` / replay）。
- Temporal self-hosting: 公式 `docs.temporal.io/self-hosted-guide`（multi-service / persistence DB /
  visibility）。
- VAZ 側根拠: `research.md` L40–103・L149–155（AI SDK in-process 検証 + 責務分割 + BullMQ 除外）;
  `plan.md` §Durable workflow engine（ADR-2）; `spec.md` R3.2/Q2。
