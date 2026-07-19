# 実装ギャップ分析: 002-pydantic-enhance

対象コミット: `93ceccd`(ブランチ `002-pydantic-enhance`)。要件は承認済み
(`spec.json` phase=requirements-generated / requirements.approved=true)。
本文書は spec.md の受入基準を既存コードと照合し、**実装戦略の材料**を提示する
(最終判断は `/sdd-plan` に委ねる)。

## 分析サマリ

- **spec の再検証は正確**: spec.md「再検証結果」の主張(V-1 system 不在、
  stopWhen=isStepCount(5) のみ、locator 不在、golden set 2 件、eval-nightly.yml
  既存、forbid スクリプトの走査範囲)は、実コードと完全一致した。設計を覆す
  齟齬は本分析でも発見なし。
- **フェーズ境界がギャップ種別と一致**: Phase A(Req1)は既存 TS の**拡張**、
  Phase B〜D(Req2-4)は `services/` が存在しないため大半が**新規**、Phase E
  (Req5-6)は評価/文書の**拡張+新規の混在**。
- **最大の技術リスクは 2 点**: (1) AI SDK v7 で「累積トークン予算」を `stopWhen`
  と `stop_reason` としてどう捕捉するか(1.3/1.4)、(2) Python↔TS 境界の
  契約ドリフト検証機構(3.2/3.4)と openapi-typescript のサプライチェーンゲート。
- **アーキテクチャは spec で確定済み**: 選択肢 B(ステートレスサイドカー)、単一
  ライター原則、境界単位の Pydantic 正本は Clarifications で固定。よって「全体
  approach」は Hybrid で不変 — 本分析の approach options は**未確定のサブ判断**に
  絞る。
- **独立着地性(NFR-1)は構造的に担保可能**: `services/` は `@vaz/*` 依存グラフ外、
  `py:check` は `check` 集約の非依存、生成 TS 型はコミット(no build step)—
  Python ツールチェーン無しでも既存ゲートは green を維持できる。

## 受入基準別ギャップ表

凡例: ✅ 既存充足 / 🔧 部分的(拡張要) / 🆕 新規構築

### Requirement 1 — チャット本線 TS 強化(Phase A)

| 基準 | 種別 | 証拠 / 補足 |
|---|---|---|
| 1.1 `CHAT_SYSTEM_PROMPT` 定数 | 🆕 | [prompt.ts](../../packages/agents/src/prompt.ts) はデリミタ/context 整形のみ。system 定数は不在 |
| 1.2 `buildStreamTextOptions` が `system` 付与 | 🔧 | [chat-agent.ts:153-175](../../packages/agents/src/chat-agent.ts#L153-L175) は `system` を渡していない(V-1 確認) |
| 1.3 `stopWhen` にトークン予算 + Zod env | 🔧 | 現状 `stopWhen: isStepCount(MAX_STEPS)` のみ([chat-agent.ts:164](../../packages/agents/src/chat-agent.ts#L164))。[env.ts](../../packages/schemas/src/env.ts) に予算変数なし |
| 1.4 `stop_reason` を telemetry + `deps.audit` | 🆕 | `buildStreamTextOptions` に `onFinish` なし。[audit-hook.ts](../../packages/agents/src/audit-hook.ts) はツール発火点のみ(run 終了理由は未捕捉) |
| 1.5 supervisor が run-metrics を optional JobEvent 拡張 | 🔧 | [workflows.ts](../../packages/schemas/src/workflows.ts) の `jobEventSchema` は discriminated union。optional 追加で NFR-6 準拠可 |
| 1.6 3 停止経路の MockLanguageModelV4 テスト | 🆕 | `options.model` 試験シームは既存。テストは新規 |
| 1.7 `docs/context-budget.md` + `prepareStep` windowing seam | 🔧 | [buildPrepareStep](../../packages/agents/src/chat-agent.ts#L114) は context 注入のみ。doc は不在(`docs/context-budget.md` MISSING) |
| 1.8 system 変更時 before/after nightly 比較 | 🆕 | プロセス要件。Req5 の還流ループ初回行使 |

### Requirement 2 — Python 評価サイドカー(Phase B)

| 基準 | 種別 | 証拠 / 補足 |
|---|---|---|
| 2.1–2.4, 2.6, 2.7 | 🆕 | `services/` ディレクトリ自体が不在。全面新規 |
| 2.5 `py:check` mise タスク(非 `check` 依存) | 🆕 | [mise.toml](../../mise.toml) の `check` = `lint/typecheck/test:run/audit/lint:model-ids`。`py:` タスク無し |

### Requirement 3 — 境界契約の単一情報源(Phase C)

| 基準 | 種別 | 証拠 / 補足 |
|---|---|---|
| 3.1 Pydantic 正本 / 既存 Zod 不変 | 🆕(方針) | 既存 Zod は不変維持。新境界のみ |
| 3.2 openapi-typescript → `generated/agent-service.ts` コミット | 🆕 | `packages/schemas/src/generated/` 不在。`openapi-typescript` は依存に無し(要 `allowBuilds`/`minimumReleaseAge` 検討) |
| 3.3 薄い手書き Zod | 🆕 | — |
| 3.4 契約ドリフト CI テスト(1 点照合) | 🆕 | sandbox `test_contract_drift.py` 同型。配置(TS vitest / Python pytest)は未定 |
| 3.5 再生成 mise タスクの文書化 | 🆕 | — |

### Requirement 4 — 取り込み強化 / 構造保持パーシング(Phase D)

| 基準 | 種別 | 証拠 / 補足 |
|---|---|---|
| 4.1 `/parse` Docling `HybridChunker` | 🆕 | services 骨格に依存 |
| 4.2 LlamaParse opt-in | 🆕 | env キー存在時のみ。既定 Docling |
| 4.3 `retrievedChunkSchema` + 永続スキーマに optional `locator` | 🔧 | [rag.ts:31-38](../../packages/schemas/src/rag.ts#L31-L38) に locator 無し。永続側は drizzle-zod 単一ソース(migration 要) |
| 4.4 ingest CLI `--via-parser`(単一ライター保持) | 🔧 | [ingest/index.ts](../../packages/rag/src/ingest/index.ts) 既存。`TEXT_EXTENSIONS`(:256)、`assertNoProviderMixing`(:116)。embed+upsert 経路は再利用 |
| 4.5 locator 引用の E2E | 🆕 | ローカルスタック検証 |
| 4.6 サービス到達不可時の fail-loud | 🆕 | 既定 ingest 経路は不変 |

### Requirement 5 — 評価還流と CI ゲート(Phase E)

| 基準 | 種別 | 証拠 / 補足 |
|---|---|---|
| 5.1 golden set ≥20 件 + README 手順 | 🔧 | 現状 2 件([nightly.ts:50-63](../../packages/evals/src/nightly.ts#L50-L63)) |
| 5.2 nightly に tier2(`/eval/*`)追加・未設定時 skip | 🔧 | [runNightlyEval](../../packages/evals/src/nightly.ts#L147) にステージ追加 |
| 5.3 PR ゲート(3 指標)を eval-nightly 機構上に | 🆕 | [eval-nightly.yml](../../.github/workflows/eval-nightly.yml) 既存(補正 2 確認)。PR ワークフローは新規 |
| 5.4 <20 件は report-only | 🆕(方針) | 閾値ブロックは 5.1 達成後 |
| 5.5 doc-gen に optional 検証ステップ | 🔧 | [supervisor.ts:208](../../packages/agents/src/supervisor.ts#L208) の doc-gen system(2 文)に併設 |
| 5.6 verifier は成果物+基準のみ受領 | 🆕 | Doer-Verifier 分離 |
| 5.7 検証失敗時 JobEvent(閉じた語彙) | 🔧 | 1.4/1.5 の語彙に依存 |

### Requirement 6 — ガバナンス文書(Phase E)

| 基準 | 種別 | 証拠 / 補足 |
|---|---|---|
| 6.1 `docs/agentops.md` | 🆕 | MISSING。CLAUDE.md から到達可能に |
| 6.2 MCP ADR(不採用理由+採用条件+設計原則) | 🆕 | `docs/adr` 不在。sandbox NR-1 写像表を輸入 |
| 6.3 ADR が §5.1 脅威モデル/§5.2 ポリシ例を参照 | 🆕 | 強化検討文書由来 |

### 非機能要件

| NFR | 種別 | 証拠 / 補足 |
|---|---|---|
| NFR-1 既存ゲート green 維持・各フェーズ独立着地 | 制約 | 構造的に担保可(サマリ参照) |
| NFR-2 forbid-model-ids.sh を `services/**/*.py` へ拡張 + config.py carve-out | 🔧 | [forbid-model-ids.sh](../../scripts/forbid-model-ids.sh) は `*.ts`/`*.tsx` の `apps`/`packages` のみ走査、`packages/config/` はディレクトリ除外(補正 1 確認) |
| NFR-3 Python 側 R4.7 プライバシ(監査は TS 側のみ) | 🆕 | 第 2 発火点を作らない |
| NFR-4 ブラウザ非公開・S2S トークン | 🆕 | JWT は将来 spec 条件付き |
| NFR-5 uv-lock + pip-audit | 🆕 | `allowBuilds`/`minimumReleaseAge` 意図の写像 |
| NFR-6 JobEvent 拡張は後方互換 | 制約 | 1.5/5.7 の optional 化制約(SSE wire 契約) |

## Approach Options(未確定サブ判断のみ)

全体アーキテクチャは spec Clarifications で **Hybrid(TS 本線拡張 + Python 新規
サイドカー)に確定**。以下は plan 段階で決すべき実装フォークに絞る。

### A. トークン予算の `stopWhen`/`stop_reason` 捕捉(1.3/1.4)

| 選択肢 | 適する場面 | コスト | リスク |
|---|---|---|---|
| **拡張**: `stopWhen` を配列化し予算述語を追加 + `onFinish` で usage/finishReason を集約 | AI SDK v7 が step 間の累積 usage を stopWhen/onFinish に露出する場合 | 低 | v7 API の累積 usage 露出形が未確認 |
| **新規**: `onStepFinish` で自前カウンタを積み、閾値超過を明示フラグ化 | 累積 usage が stopWhen に届かない場合の確実策 | 中 | 実装が増える。停止語彙との写像を自前設計 |

**推奨**: まず `node_modules/ai/docs/` で v7 の `stopWhen`/`onFinish`/`onStepFinish`
の usage 露出を確認 →拡張優先、不可なら onStepFinish カウンタへフォールバック。

### B. 契約ドリフトテストの配置(3.4)

| 選択肢 | 適する場面 | コスト | リスク |
|---|---|---|---|
| **TS 側 vitest**: 生成型/薄い Zod ↔ コミット済み OpenAPI を照合 | 既存 CI(pnpm/vitest)に載せたい | 低 | OpenAPI スナップショットの再生成手順が要 |
| **Python 側 pytest**: `services/agent` の `py:check` 内で FastAPI schema を検証 | Python 正本の近傍で検証したい | 中 | `py:check` は `check` 非依存 → PR で別途起動が要 |

**推奨**: 正本(Pydantic)と生成物(TS)の**両端**を 1 点で突き合わせる性質上、
TS 側 vitest に置き既存 CI で常時実行。sandbox `test_contract_drift.py` の
「1 点照合」形は維持。

### C. Python サービスのローカル起動 vs docker-compose 統合(Phase B/NFR-4)

| 選択肢 | 適する場面 | コスト | リスク |
|---|---|---|---|
| **新規(最小)**: uv ローカル起動のみ(spec 明記の許容) | Phase B 着地を最速化 | 低 | nightly/CI から到達させる配線が別途要 |
| **ハイブリッド**: 最小起動 + docker-compose サービス追記 | ローカルスタック統合を早期に | 中 | 本番配備要件が未確定(spec は Out of Scope) |

**推奨**: spec の Out of Scope に従い **uv ローカル起動を既定**。compose 統合は
本番配備要件が出た時点で追補(Phase B のスコープを膨らませない)。

## Plan 段階で深掘りが必要な調査項目

1. **AI SDK v7 の停止/終了 API**(1.3/1.4): `stopWhen` 述語への累積 usage 露出、
   `onFinish` の `{ finishReason, usage, steps }` 形。`node_modules/ai/docs/` で確認。
2. **openapi-typescript のサプライチェーン**(3.2): バージョン選定、`minimumReleaseAge`
   (24h)、install script 有無 →`allowBuilds` エントリ要否。生成はビルド step 化
   せずコミット運用。
3. **pgvector 永続スキーマへの locator 追加**(4.3): [rag/db/schema.ts] の chunk
   テーブル + drizzle-zod 単一ソース。optional 列 + migration、既存 ingest の
   byte 互換(値未書き込み)確認。
4. **Docling `HybridChunker` / LlamaIndex 評価器 API**(2.2/4.1): `FaithfulnessEvaluator`/
   `RelevancyEvaluator` の入出力、judge モデルの env 注入形、ネットワーク遮断
   テスト(`httpx.ASGITransport`)の決定論フェイク。
5. **golden set 拡充の出所と匿名化**(5.1): audit log からの実会話/失敗抽出、
   R4.7 準拠の匿名化手順、`packages/evals/README.md` への手順記載。
6. **PR ゲートの 3 指標算出**(5.3): pass-rate delta / over-under-trigger balance /
   per-case cost・latency を eval-nightly 機構上でどう出力・比較するか(baseline 保持)。

## 次のステップ

- ギャップの所在と技術リスクを確認のうえ `/sdd-plan 002-pydantic-enhance` で技術
  設計文書を作成。特に上記調査項目 1・2・3 は plan で解消すべき前提。
- フェーズ独立着地(NFR-1)を保つため、plan は Phase A を先行・独立トラックとして
  切り出し、Phase B→C→(D, E の 5.2/5.5)の依存順を明示することを推奨。
