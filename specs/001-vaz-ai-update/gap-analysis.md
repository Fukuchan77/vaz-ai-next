# 001-vaz-ai-update — Implementation Gap Analysis

> `/sdd-validate-gap` の成果物。承認済み要件（`spec.md` R1〜R5 / NFR-1〜7）と既存
> コードベースの差分を整理し、`/sdd-plan` の設計判断へ情報提供する。**決定ではなく
> 選択肢と根拠を提示する。**

## Analysis Summary

- **性質はグリーンフィールド寄りのブラウンフィールド**: エージェント/RAG/ワークフロー/
  可観測性の対象パターンは既存コードに皆無（`grep` で `createChatAgent` / `drizzle` /
  `experimental_telemetry` / `needsApproval` / `langfuse` / `inngest` = **NONE FOUND**）。
  一方 Phase 1 が土台にする資産（env 駆動プロバイダ・Zod 境界・品質基盤）は良質で再利用価値が高い。
- **AI SDK 7 が要件の多くを一次プリミティブで提供**: 同梱 docs（`node_modules/ai/docs/`）に
  `ToolLoopAgent` + `runtimeContext`、native **tool-approvals**、workflow/subagents、
  `telemetry`（OTel）、`testing`（MockLanguageModel）、`embeddings`/`reranking` が存在。
  → 対応表の多くは「自作」ではなく「AI SDK 標準の薄いラップ」で満たせる。
- **中心的アーキ課題は「耐久性」の一点**: R3.7（ワーカー再起動を跨いで完走）/ R3.8（翌日再開）は
  AI SDK のワークフローが **in-process** であるため単独では満たせない。**AI SDK 合成 +
  外部耐久エンジン（Inngest/Temporal）のハイブリッド** が必然。Q1 スパイクの主眼。
- **最大の統合リスクはツールチェーンのワークスペース化**（R1.9）: `tsconfig`（Next 管理 +
  `@ → ./src` alias）、`vitest.config`（単一 include/alias）、Playwright webServer、git hooks
  の bare `pnpm exec` は全て単一パッケージ前提。段階移行で最初に触れる面が最も広い。
- **推奨アプローチ = 段階的モノレポ（Hybrid / Phased）**: Phase 1 で骨格＋ web 移設＋
  agents/tools/schemas/config 抽出（挙動等価）、以降 rag/worker/evals をパッケージ追加で
  漸進。Q5 厳密分離・NFR-5 後方互換と一致。

## 既存資産マップ（再利用対象）

| 資産 | 位置 | Phase 1 での扱い |
|------|------|------------------|
| `resolveModel(env)` 環境変数駆動プロバイダ解決 | [src/lib/ai/provider.ts:13](../../src/lib/ai/provider.ts#L13) | `packages/agents`（または `packages/config`）へ移設。R1.8 の env 駆動原則の実体。 |
| `aiEnvSchema` / `parseAiEnv`（空文字→undefined） | [src/lib/ai/env.ts:7](../../src/lib/ai/env.ts#L7) | `packages/schemas` へ移設し、R2.3（`AI_EMBEDDING_PROVIDER`）/ R4（`LANGFUSE_*`）/ R3（engine 設定）で拡張。 |
| `chatRequestSchema`（UIMessage loose 検証） | [src/lib/ai/chat-schema.ts:8](../../src/lib/ai/chat-schema.ts#L8) | `packages/schemas` へ。NFR-6 単一正本の起点。 |
| `streamText` + `tool()` + `stopWhen: isStepCount(5)` | [src/app/api/chat/route.ts:33](../../src/app/api/chat/route.ts#L33) | `createChatAgent(deps)`（`ToolLoopAgent` ラップ）へ抽出。route は薄いアダプタへ（R1.5）。 |
| `getCurrentTime` デモツール | [src/app/api/chat/route.ts:15](../../src/app/api/chat/route.ts#L15) | `packages/tools`（capability パターン）へ。`execute` を deps closure 化（R1.4）。 |
| `useChat` チャット UI | [src/features/chat/Chat.tsx:43](../../src/features/chat/Chat.tsx#L43) | `apps/web` に残置。R3.6 で `useJobStream` を兄弟実装。 |
| 品質基盤（Biome/Vitest/Playwright/hooks/CI/supply-chain） | ルート各 config + `.githooks/` | 非劣化維持（NFR-1）。ワークスペース対応へ改修（下記課題）。 |

## 要件別ギャップ表

凡例: ✅ 既存充足 / 🔧 部分（要拡張）/ 🆕 新規。

### Requirement 1 — モノレポ化 + Agent 層（Phase 1）

| ID | 判定 | 根拠 / メモ |
|----|------|-------------|
| 1.1 workspace 構成 | 🆕 | `pnpm-workspace.yaml` は「packages は定義しない」明記（[pnpm-workspace.yaml:1](../../pnpm-workspace.yaml#L1)）。`apps/*` `packages/*` glob を追加。 |
| 1.2 supply-chain 維持 | 🔧 | `minimumReleaseAge` / `allowBuilds` は移設後も維持（[pnpm-workspace.yaml:7](../../pnpm-workspace.yaml#L7)）。新規ネイティブ依存（pg 等）は allowBuilds へ追記が必要。 |
| 1.3 `createChatAgent(deps)` | 🔧 | AI SDK 7 `ToolLoopAgent` + `runtimeContext`（deps 相当）を薄くラップ。ファクトリ closure で `AgentDeps` 注入。 |
| 1.4 `tool()` + deps closure | 🔧 | 既存 `tool({inputSchema})` パターンあり（route.ts:15）。`execute` を deps 参照へ変更。 |
| 1.5 route 薄アダプタ化 | 🔧 | 現状はオーケストレーションが route 直書き（route.ts:33）。`@vaz/agents` へ委譲。 |
| 1.6 MockLanguageModel 単体テスト | 🆕 | AI SDK `docs/03-ai-sdk-core/55-testing.mdx` + `simulate-readable-stream` を利用。ネットワーク非依存。 |
| 1.7 回帰なし（provider 切替等価） | 🔧 | 既存 E2E（`chat-ollama.spec.ts` 自動 skip）を移設後も緑に。 |
| 1.8 model ID 直書き禁止 lint | 🆕 | 現状ガードなし。Biome 2.5 カスタムルール or CI grep で実装（要調査）。 |
| 1.9 hooks/CI ワークスペース緑 | 🔧 | bare `pnpm exec`（[.githooks/pre-commit:7](../../.githooks/pre-commit#L7)）を `pnpm -r` / mise ワークスペースタスクへ。 |
| 1.10 Phase 1 で RAG/WF 混入禁止 | 🆕 | プロセス制約。tasks/CI で範囲を明示的に限定。 |

### Requirement 2 — RAG 層（Phase 2）

| ID | 判定 | 根拠 / メモ |
|----|------|-------------|
| 2.1 `packages/rag`（ingest/retrieve/tools） | 🆕 | 皆無。capability export は既存 `tool()` パターンを踏襲可。 |
| 2.2 pgvector + Drizzle + docker-compose | 🆕 | DB・ORM・compose すべて未導入。ネイティブ依存の allowBuilds 影響。 |
| 2.3 埋め込み env 駆動（既定 Ollama） | 🔧 | `resolveModel` の env 駆動思想を `embedMany`（`docs/.../30-embeddings.mdx`）へ横展開。`aiEnvSchema` 拡張。 |
| 2.4 引用（`RetrievedChunk`/`Citation`） | 🆕 | 型契約を `packages/schemas` に新設（NFR-6）。 |
| 2.5 `recall@k` golden set（LLM 不要） | 🆕 | Vitest で埋め込みのみ実行。CI に組込む評価土台。 |
| 2.6 `pnpm --filter @vaz/rag ingest` | 🆕 | ワークスペース filter 前提（R1.1 依存）。 |
| 2.7 reranker なしで動作 | 🆕 | AI SDK `docs/.../31-reranking.mdx` は存在するが MVP は不使用（将来）。 |

### Requirement 3 — ワーカー / ワークフロー / HITL（Phase 3）

| ID | 判定 | 根拠 / メモ |
|----|------|-------------|
| 3.1 `apps/worker`（Node 24 コンテナ） | 🆕 | 新規プロセス + Dockerfile。`pnpm deploy` でワークスペース切り出し要検討。 |
| 3.2 耐久エンジン（スパイクで選定） | 🆕 | **中心課題**。AI SDK ワークフローは in-process → 外部エンジン必須。Q1。 |
| 3.3 型付きハンドオフ（supervisor+専門） | 🔧 | AI SDK `subagents`/`workflows` docs を合成に活用 + `packages/schemas/workflows.ts` で I/O 固定。 |
| 3.4 破壊的ツール `needsApproval` + 承認 UI | 🔧 | AI SDK native **tool-approvals**（`docs/03-agents/06-tool-approvals.mdx`）で契約は標準化。UI は新規。 |
| 3.5 承認イベントで再開 | 🔧 | 承認契約は AI SDK、**永続的中断/再開はエンジン責務**（ハイブリッド）。 |
| 3.6 SSE 進捗（`useJobStream`） | 🆕 | Route Handler(SSE) + DB/Redis pub/sub。判別共用体イベント型は schemas。 |
| 3.7 10 分超・再起動跨ぎ完走 | 🆕 | 耐久性の実証。AI SDK 単独では不可 → エンジン依存。 |
| 3.8 翌日承認→再開 E2E | 🆕 | 長時間シナリオの E2E 設計が必要。 |

### Requirement 4 — 可観測性 + 評価（Phase 4／OTel は Phase 1 前倒し）

| ID | 判定 | 根拠 / メモ |
|----|------|-------------|
| 4.1 `experimental_telemetry`→Langfuse | 🆕 | AI SDK `docs/.../60-telemetry.mdx` に OTel あり。Langfuse exporter 配線は新規。 |
| 4.2 trace に jobId/userId/agent | 🆕 | span 属性設計。 |
| 4.3 Langfuse 未設定で fail-soft | 🆕 | 初期化失敗を握り潰し警告 1 回（NFR-4）。 |
| 4.4 3 層評価ハーネス | 🆕 | unit(既存 Vitest 拡張) / recall@k(R2.5) / LLM-judge(evalite or promptfoo)。 |
| 4.5 outcome+behavior 分離採点 | 🆕 | `GradeReport` 契約を schemas に。 |
| 4.6 `eval:nightly` + コスト上限 | 🆕 | 新規 GitHub Actions ワークフロー（既存 CI と別ゲート）。 |
| 4.7 生プロンプト/ツール I/O を INFO 非記録 | 🆕 | ロギング方針。既存にロガー抽象なし → `AgentDeps.logger` 導入時に規定。 |

### Requirement 5 — セキュリティ（Phase 5）

| ID | 判定 | 根拠 / メモ |
|----|------|-------------|
| 5.1 社内 IdP OIDC + deps 権限スコープ | 🆕 | 認証は現状スコープ外（steering `product.md` Out of Scope）。方式は Phase 5 開始時確定（Q4）。 |
| 5.2 RAG 文書を非信頼入力として区切り注入 | 🆕 | プロンプト構築規約。R2.4 と同時設計が安全。 |
| 5.3 外部読取駆動時は破壊的ツール無効/HITL | 🔧 | AI SDK **policy tool-approvals**（`docs/.../06-policy-tool-approvals.mdx`）が方針適用に有用。 |
| 5.4 外部送信の宛先許可リスト | 🆕 | ツール実装規約。 |
| 5.5 全ツール実行の監査ログ（DB） | 🆕 | エンジン採用でほぼ自動取得（R3.2 依存）。 |

## 統合課題（Integration Challenges）

1. **tsconfig のワークスペース化**: 現 `tsconfig.json` は Next 管理 + `paths: @/* → ./src/*` +
   `include: src`（[tsconfig.json:20](../../tsconfig.json#L20)）。`apps/web` へ移すと alias/include が変わり、
   各 package は独自 tsconfig（`packages/config` で base 共有）が必要。ルート `tsc --noEmit` は
   **project references** か `pnpm -r typecheck` へ。
2. **Vitest のワークスペース化**: `@ → ./src` alias と `include: tests/**`、`coverage.include: src/**`
   は単一パッケージ前提（[vitest.config.ts:6](../../vitest.config.ts#L6)）。Vitest **projects**（旧 workspace）で
   package ごとに env（web=jsdom / agents・rag=node）を分離。カバレッジ閾値も package 単位へ。
3. **Playwright webServer**: `pnpm dev`/`pnpm start`（[playwright.config.ts:28](../../playwright.config.ts#L28)）を
   `pnpm --filter @vaz/web ...` へ。Phase 3 は worker + DB を要する E2E 環境（compose）が必要。
4. **git hooks の bare コマンド**: pre-commit/pre-push が root で `pnpm exec ...` 直呼び
   （[.githooks/pre-commit:4](../../.githooks/pre-commit#L4)）。`pnpm -r` / mise タスク経由へ改修（R1.9・NFR-1）。
5. **supply-chain の拡張**: `pnpm-workspace.yaml` に `packages`/`apps` を追加しつつ
   `minimumReleaseAge`/`allowBuilds` を維持（R1.2）。新規依存（pg・drizzle・otel・langfuse・
   workflow engine・sharp 等）のうち install script を持つものは allowBuilds へ監査記録。
6. **React Compiler の適用境界**: `babel-plugin-react-compiler` / `reactCompiler: true` は web 専用
   （[next.config.ts:5](../../next.config.ts#L5)）。node ライブラリ package では有効化しない。
7. **依存バージョン整合**: `ai@^7` に対し `@ai-sdk/anthropic@^4` / `@ai-sdk/react@^4`
   （[package.json:8](../../package.json#L8)）。Agent/telemetry/tool-approval API は同梱 docs で存在確認済み。
   provider 側 API は plan 前にバージョン別に要確認。
8. **耐久性の非機能ギャップ（最重要）**: AI SDK の agent ループ/ワークフローは in-process。
   R3.7/R3.8 の「再起動跨ぎ・数日中断」は外部エンジンの永続化が担う。**AI SDK=合成契約 /
   エンジン=耐久・中断再開** の責務分割を plan で明文化。
9. **ロガー抽象の不在**: `AgentDeps.logger`（R1.3）は新設。R4.7 の PII 非記録方針は logger 規約として同時定義。

## アプローチ選択肢（フィーチャ全体）

| アプローチ | 適合ケース | コスト | リスク | 評価 |
|-----------|-----------|--------|--------|------|
| **A. 段階的モノレポ（Hybrid/Phased）** | 後方互換を保ち Phase 単位で検証 | 中 | 統合（初期の config 改修に集中） | **推奨**。Q5 厳密分離・NFR-5 と一致。Phase 1 で骨格+web 移設+agents/tools/schemas/config 抽出（挙動等価）、以降 rag/worker/evals を追加。 |
| B. ビッグバン再構成 | 全 Phase を一括設計・実装 | 高 | 高（回帰・巨大 PR・NFR-5 違反） | 非推奨。段階検証不能。 |
| C. モノレポ化を遅延（src 内で agent 層のみ先行） | 最小変更で agent 抽象だけ導入 | 低 | R1.1 未達（workspace 必須） | 非推奨。要件と矛盾。 |

### サブ領域別の実装スタンス（plan で確定する論点）

- **Agent 抽象**: AI SDK `ToolLoopAgent` を薄くラップした `createChatAgent(deps)` を推奨
  （車輪の再発明を避ける）。deps は `runtimeContext` / closure のどちらで通すか要検証（R1.3/1.6）。
- **ワークフロー & 耐久性**: ハイブリッド固定（AI SDK 合成 + 外部エンジン耐久）。**エンジン選定
  （Inngest vs Temporal）は Q1 スパイクへ委譲**。
- **埋め込み**: `resolveModel` の env 駆動を `embedMany` へ横展開、既定 Ollama ローカル（R2.3/Q2）。
- **可観測性**: AI SDK OTel 計装を Phase 1 から有効化 → Langfuse exporter は fail-soft 初期化（R4.1/4.3・NFR-7）。

## plan フェーズで深掘りすべき調査項目（research.md 候補）

1. **耐久エンジン スパイク（Q1）**: Inngest vs Temporal TS で「承認待ち数日中断→再開」を
   実装比較。自己ホスト運用負荷・ライセンス・AI SDK tool-approvals との接続点（R3.2/3.4/3.5）。
2. **AI SDK `ToolLoopAgent` + deps 注入**: `runtimeContext` vs closure の型付け・テスト容易性を
   MockLanguageModel と併せて検証（R1.3/1.6）。
3. **pgvector + Drizzle**: インデックス戦略（HNSW/IVFFlat）、プロバイダ別の埋め込み次元、
   マイグレーション運用（R2.2/2.3）。
4. **OTel → Langfuse 配線**: AI SDK `experimental_telemetry` の span 属性（jobId/userId/agent）と
   fail-soft 初期化パターン（R4.1–4.3）。
5. **モノレポ ツールチェーン**: tsconfig project references / Vitest projects / Biome / カバレッジ
   閾値の package 分割、mise の `-r`/`--filter` タスク設計（R1.9・NFR-1/2）。
6. **`forbid-hardcoded-model-ids`**: Biome 2.5 のカスタム lint プラグイン可否 vs CI grep ゲート（R1.8）。
7. **worker コンテナ化**: `pnpm deploy` によるワークスペース切り出し、Docker base image、Node 24（R3.1）。
8. **評価ハーネス**: evalite（Vitest 基盤）vs promptfoo の選定と CI コスト上限設計（R4.4/4.6）。

## Document Status

- 分析手法: `rules/gap-analysis.md` 準拠（要件マップ → 既存コード survey(Grep/Read) →
  要件別 ✅/🔧/🆕 分類 → 統合課題 → アプローチ比較 → 調査フラグ）。
- 既存コード・全 config・git hooks・`node_modules/ai/docs/` の AI SDK 7 プリミティブを実地確認。
- steering（product/tech/structure）を全読込済み。出力言語 `ja`（spec.json）。

---

_Gap analysis generated: 2026-07-04_
