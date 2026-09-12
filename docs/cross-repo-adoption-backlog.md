# 相互取り込み backlog（vaz-ai-next）

Agentic AI 系 5 リポジトリを横断で突き合わせた検証の、本 repo 向け抜粋。
**根拠・実測値・全 16 項目の本文は `vaz-agentic-ai-next/docs/cross-repo-adoption-review.md` が正本**。
本文書は重複させず、項目 ID（X-n）で参照する。

本 repo の [`docs/agentic-engineering-review.md`](agentic-engineering-review.md) は
8 手法（PE / CE / LE / HE / AE / AO / MCP / EV）の一次情報レビューであり、
**横断レビューが参照する ID 体系（`[A1]`〜`[A9]` / `[I1]`〜`[I8]`、PE-1〜EV-6）の正本**。
今回の横断レビューは、そこで単一 repo に行われた評価を 5 repo に広げたもの。

- 検証日: 2026-09-06
- 兄弟 repo: `beeai-agentic-ai-sandbox` / `pydantic-ai-sandbox` / `fastapi-pydantic-ai-agent` / `vaz-agentic-ai-next`

---

## 1. この repo が出す資産

| 資産 | 場所 | 何が独自か |
|---|---|---|
| 8 手法の一次情報レビュー | `docs/agentic-engineering-review.md`（338 行） | Anthropic 9 件・IBM 8 件を ID 付きで整理し、PE-1〜EV-6 の検証済みベストプラクティスに落とした唯一の文書。**5 repo 横断レビューの土台** |
| コンテキスト予算の段階導入設計 | `docs/context-budget.md`（146 行） | Stage 0（全履歴＋停止述語）→ Stage 1（`prepareStep` 窓化シーム、**未指定時 byte 等価**）→ Stage 2（自動 compaction）。`totalTokens` が reasoning を含みうるため `inputTokens + outputTokens` を自前合算する理由まで記録 |
| AgentOps ランブック | `docs/agentops.md`（148 行） | 可観測性・評価・最適化の 3 本柱を実コードへ写像。**未実装の項目を要件 ID 付きで明示する**書き方（実装済みのように描く事故を避ける） |
| 3 層 evals ＋ PR ゲート | `packages/evals/`（`src/pr-gate.ts` / `src/nightly.ts` / `src/judge.ts` / `src/unit/`） | ベースライン差分・over-under-trigger balance・case あたりトークン/所要時間・**20 件未満は `reportOnly`**。5 repo 中で最も成熟した eval 運用 |
| MCP ポジション ADR | `docs/adr/0001-mcp-position.md` | 5 repo 中**唯一の MCP 資産**。不採用の理由 ＋ 採用トリガ条件 ＋ `needsApproval` ↔ MCP `destructiveHint` の写像方針 ＋ サーバの供給網審査 |
| 境界契約の 2 脚 | `mise run openapi:gen` → `packages/schemas/src/generated/` ＋ 手書き Zod ラッパ | `satisfies z.ZodType<Generated>` は**余剰フィールドを捕まえない**ので JSON-Schema 形状比較と併用する、という記録（`AGENTS.md`） |
| durable HITL | `packages/agents/src/supervisor.ts` ＋ `apps/worker/src/inngest.ts` | エンジン非依存の `WorkflowStepRunner` seam で**ワーカー再起動を跨ぐ** suspend/resume。承認ゲートと `RECIPIENT_ALLOWLIST` の**独立 2 ゲート**、sticky taint（外部由来コンテンツ注入後は run 終端まで latch） |
| 単一発火点の監査 | `packages/agents/src/audit-hook.ts` | 承認ゲート通過後・`execute` 直前の 1 箇所のみ。web/worker 両パスを覆う。R4.7 プライバシー契約（raw prompt / tool args をログに出さない） |

## 2. この repo が取り込む項目

| ID | 内容 | 出所 | 工数 | 受け入れ条件 |
|---|---|---|---|---|
| **X-1（最優先）** | Actions の SHA 固定と `permissions:` 宣言。実測で **SHA 固定 0/22、`permissions:` 宣言 0/6** — 5 repo 中で最も弱い | `fastapi-pydantic-ai-agent`（SHA 固定 5/5）＋ そのガードテスト `fastapi-pydantic-ai-agent/tests/unit/test_ci_workflows.py`（224 行） | S | 6 ワークフロー全ての `uses:` が 40 桁 SHA、全ワークフローが最小 `permissions:` を宣言。**TS 側の repo ガードが 0 件なので、これを機に vitest で同等のガードを新設する**（YAML パース＋「走査ファイル数 > 0」アサート） |
| **X-2** | ネットワーク遮断の**構造的保証**。`MockLanguageModelV4` 注入で実質ネットワークに出ないが、モック漏れを構造的に落とす仕組みが無い | `fastapi-pydantic-ai-agent/tests/support/hermetic.py`（47 行）／`pydantic-ai-sandbox` の `connect_ex`＋`getaddrinfo` 版 | S | vitest setup で `fetch` / undici を落とし、ユニットテスト中の外向き通信を大声で失敗させる。ガードが空振りでないことを証明するテストを 1 本 |
| **X-14** | E2E の CI レーン。現状 pre-push フックのみで **`--no-verify` で素通りし CI の安全網が無い**（`AGENTS.md` 自身が §12 R10 との矛盾として記載） | `beeai-agentic-ai-sandbox/apps/frontend/tests/e2e/`（10 spec、うち `09-accessibility` は `@axe-core/playwright` による a11y 検査） | M | `.github/workflows/tests.yml` にジョブを追加（**新規ワークフローを作らない** — 第 2 の CI 経路は principle 5 違反）。X-3 の非空アサート（収集テスト数 > 0）を同時に入れる |
| **X-14b** | a11y E2E の導入。**本 repo に a11y 検査が皆無**。Carbon Design System を使う `apps/web` にこそ効く | `beeai-agentic-ai-sandbox` の `@axe-core/playwright` spec | S | 既存の Playwright 構成に追加。X-14 と同時に着地させる |
| **X-13** | OWASP 対応表の新設（**現状皆無**） | `fastapi-pydantic-ai-agent/docs/owasp-agentic-llm-mapping.md`（LLM Top 10、全行に実装＋テストを引用）＋ `pydantic-ai-sandbox/patterns/SECURITY-NOTES.md`（Agentic AI Top 10 をレイヤ別に） | S | 2 表は対象タクソノミが異なり重複しない。**各行にテストを引用する**形式を採ること（無いと主張のリストに退化する） |
| **X-15** | `.github/dependabot.yml` の新設（`security-daily.yml` はあるが更新提案が来ない） | `fastapi-pydantic-ai-agent/.github/dependabot.yml` ＋ `fastapi-pydantic-ai-agent/tests/unit/test_dependabot_config.py` | S | 意図的に据え置いている 3 メジャー（`vitest` 4.x / `typescript` 6.x / `@types/node` 24）を `ignore:` に載せ、理由をコメントで残す（`AGENTS.md` の記述と一致させる） |
| X-3 | 空振り検知（anti-false-green）の導入 | `pydantic-ai-sandbox/patterns/contracts/src/patterns_contracts/pytest_live_guard.py`（62 行）の TS 相当 | S | Playwright レーン・`py:check` レーンで「収集テスト数 > 0」を強制 |
| X-5 | 停止理由語彙の写像表を参照可能にする。本 repo の `runStopReasonSchema` は `natural`/`step-cap`/`budget-exceeded`/`error` の **4 値**で、Python 側 2 repo の 5 値（`denied` / `disallowed_tool` を含む）と非対称 | 横断レビュー §2 X-5 の写像表 | S | **今回は統一しない**（`JobEvent` SSE 契約と `audit_log` の後方互換に影響）。`docs/context-budget.md` の停止理由節から写像表へリンクし、拒否が別経路であることを明記 |
| X-9 | HITL の**配線**。契約はあるが動いていない: `createEmailCapability` がどのエージェントにも未登録／`Chat.tsx` に `addToolApprovalResponse` が無い／`apps/worker` の述語が `requiresApprovalForKind: () => false` | 参照実装は `pydantic-ai-sandbox/patterns/hitl/`（v2 deferred tools ＋ consume-once ＋ サーバ側履歴が正） | M | 3 箇所の配線 ＋ approve/deny/malformed の E2E。**承認は不可逆・高リスク操作のみ**（増やす方向へ行かない） |
| X-11 | ドリフト検知エラーに**直し方を書く** | `beeai-agentic-ai-sandbox/.github/workflows/ci.yml` の `schema-drift` ジョブ（`::error::` に実行コマンドを書く） | S | `codegen-check` 相当の失敗時に再生成コマンドを出力 |
| X-16 | 6 パターン教材への参照 | `beeai-agentic-ai-sandbox/effective_agents/`（`_print_usage()` による ~15× コストの可視化）／`pydantic-ai-sandbox/patterns/deep-research/COMPARISON.md` | S | **実装は不要**。多エージェント検討時のゲート判断材料へのリンクのみ |

## 3. 実装状況(2026-09-08)

X-1 / X-2 / X-3 / X-5 / X-11 / X-13 / X-14 / X-14b / X-15 / X-16 は着地済み。詳細は各行の
受け入れ条件を参照(実装コードとテストへのリンクはこの節では重複させない)。

- X-9(HITL の配線)は 3 箇所のうち 2 箇所を着地: `createEmailCapability` を
  `packages/agents/src/chat-agent.ts#buildChatTools` に登録(chat のツールセットへ)、
  `Chat.tsx` に `addToolApprovalResponse` ベースの承認/却下 UI を実装。
  approve/deny/malformed の E2E は `apps/web/tests/e2e/hitl-approval.spec.ts`
  (malformed の 2 本はモデル呼び出し不要・CI で常時実行、approve/deny の 2 本は
  `chat-anthropic.spec.ts` と同じ資格情報ゲートで自己スキップ)。
  **`apps/worker` の `requiresApprovalForKind: () => false` は意図的に未着手のまま** —
  今日どの supervisor specialist も破壊的ツールを呼ばないため(`sendEmail` は chat 専用に
  なった)、`true` を返す変更はどの kind に対しても意味を持たない。正しく閉じるには
  `workflowStepSchema` にステップ単位の承認要否フラグを足す横断的変更が要る
  (`apps/web/tests/e2e/approval-resume.spec.ts` の SCOPE/FIDELITY 節に詳細)。
  `apps/worker/src/start.ts` のコメントをこの現状に合わせて更新済み。

### 3.1 追補(2026-09-12)

§2 の表は**取り込み時点のスコープ記録**なので現状に追随させていない。以降の変更点:

- **X-14 は着地済み**だが、`tests.yml` の `e2e` ジョブは pre-push フックより意図的に狭い
  (chromium のみ・サービスコンテナ無し・プロバイダー資格情報無し)。X-14 の受け入れ条件
  「`--no-verify` で CI の安全網が無い」は解消済みで、README と `.githooks/pre-push` の
  「CI に `e2e` ジョブは無い」という記述が残っていたのを修正した。
- **X-15 の据え置きメジャーは 3 → 2 に減った**。root の `typescript` を 7.x へ移したため
  (`vitest` 4.x / `@types/node` 24 のみが据え置き)。`packages/schemas` だけ
  `openapi-typescript` のために `typescript` 6.0.3 を pin しており、Dependabot はマニフェスト
  単位の `ignore` を書けないので**受容済みの既知ギャップ**として扱う(詳細は
  `docs/dependency-policy.md` §7)。
- **X-9 の 1 段目に欠陥が見つかり修正した**。HITL 承認ゲートは配線されていたが署名鍵が
  未配線で、偽造された `tool-approval-response` が受理され `sendEmail.execute` まで到達して
  いた(実際に止めていたのは 2 段目の空 `RECIPIENT_ALLOWLIST`)。`hitl-approval.spec.ts` の
  「偽造 approvalId は honored されない」ケースは、CI にプロバイダー資格情報が無く後続の
  モデル呼び出しが失敗することで通っていた**偽 green** だった。詳細は
  `docs/owasp-agentic-ai-top10-mapping.md` の Tool Misuse 節と AGENTS.md の R5.6 節。
- **spec 005 task 4.7 の未実施チェックを自動化した**。「`.env.example` のキー集合 ⊇ コードの
  `process.env` キー集合」は当時エージェントの permission 設定でファイルが読めず手動確認に
  留まっていた(`specs/005-baseline-recovery-refactor/pdca/do.md` §4.5)。`TOOL_APPROVAL_SECRET`
  の記載漏れで同じドリフトが再発したため、`tests/repo/env-example.spec.ts` として双方向
  (欠落＋孤児キー)＋走査の非空アサート(X-3)で恒久化した。同時に `.env.example` を宛先
  (`apps/web/.env.local` / 直下 `.env` / `services/agent/.env`)別に再構成し、compose 内部名に
  なっていた `DATABASE_URL`・`REDIS_URL`・`INNGEST_BASE_URL` をホスト視点の値へ修正した。

## 4. この repo 固有の注意

- **新規ワークフローファイルを作らない**（X-14）。実ワークフローは `lint.yml` / `tests.yml` /
  `python.yml` / `security-daily.yml` / `eval-pr.yml` / `eval-nightly.yml` の 6 本で、
  lint / test / Python / audit は既に独立して走っている。第 2 の CI 経路は principle 5 違反。
  GitHub Actions の job id にコロンは使えない（`test-unit` ＋ `name: "test:unit"`）。
- **`JobEvent` は SSE 契約**。X-5 / X-9 でフィールドを増やす場合は optional で後方互換に。
  `JobEvent.ts` は ISO 文字列、`AuditEntry.ts` は `Date`（プロセス内のみ）— 混同しない。
- **model ID は `@vaz/config` と `@vaz/schemas/src/env.ts` にのみ**（`lint:model-ids` が grep ゲート）。
  取り込むコードに model 文字列が含まれていないか確認する。
- **`mise run check` は Python ツールチェーン無しで緑を維持する**（`py:check` は依存に入れない）。
  X-2 の TS 側遮断は `check` に載せてよいが、Python 側と混ぜない。
- **意図的に据え置いている 3 メジャー**（`vitest` 4.x / `typescript` 6.x / `@types/node` 24）は
  それぞれ判断であり陳腐化した範囲指定ではない。X-15 の `ignore:` はこれを反映すること
  （`AGENTS.md` の該当項が正本）。
- **`packages/*` はビルド無しの source-only**。取り込みで per-package `tsc` を足さない。
