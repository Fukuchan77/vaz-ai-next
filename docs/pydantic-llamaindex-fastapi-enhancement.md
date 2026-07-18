# PydanticAI + LlamaIndex (+FastAPI) による強化検討 — ハイブリッドスタック設計

- **検討日**: 2026-07-18
- **対象コミット**: `d3208e6`(`docs/agentic-engineering-review.md` 追加直後)
- **入力(3 文書)**:
  1. アーキテクチャ設計レポート「Agentic AI アプリ開発における最先端技術トレンドと
     アーキテクチャ設計」(添付。以後 **[HR]** = Hybrid Report。§番号で引用)
  2. 本リポジトリの 8 手法レビュー
     [`docs/agentic-engineering-review.md`](./agentic-engineering-review.md)
     (コミット `d3208e6`。指摘 V-1..V-7 / 計画 RV-1..RV-7)
  3. `pydantic-ai-sandbox` の 8 手法レビュー
     `specs/document-review/agentic-engineering-review.md`(コミット `399633a`。
     指摘 N-1..N-4 / 計画 NR-1..NR-4、姉妹編の 3 観点レビュー R1..R8 を含む)
- **目的**: [HR] が提示する「TypeScript フロントエンド/オーケストレーション層 +
  Python バックエンド/データ・評価処理層」のハイブリッド構成を本リポジトリに適用すべきか、
  適用するならどの範囲・どの順序かを、実コードと両レビューの指摘に照らして判断する。

---

## §0 結論(要旨)

**「本線は VAZ スタックのまま、Python は"データ・評価処理層"に限定したサイドカーとして
段階導入する」**(後述の選択肢 B)を推奨する。

- [HR] のハイブリッド構成の価値の中心は、本リポジトリにとって
  **(1) LlamaIndex/Docling による複雑文書パーシング**(現行 ingest は `.md`/`.mdx`/`.txt`
  のみ)と **(2) LlamaIndex Faithfulness / Relevancy による RAG 忠実性評価の CI ゲート化**
  ([HR] §3.3)にある。どちらも TS エコシステムに実用同等物が薄く、Python 切り出しが合理的。
- 一方 [HR] §1.1 の「チャット本線を Pydantic AI + `VercelAIAdapter` で置き換える」構成は、
  本リポジトリでは**実装済み防御(system 側デリミタ対比・sticky taint R5.3・監査単一発火点・
  HITL 2 ゲート)の Python 再実装**を意味し、いま得られる便益より移行リスクが大きい。
  採用条件を固定した上でデフォルト非着手(選択肢 C を条件付き保留)とする。
- 既存計画 RV-1..RV-7 の優先順位は**変更しない**。本検討はそれと直交する導入トラックであり、
  RV-4(評価の本番還流)と RV-6(MCP ADR)は本計画と合流する。

---

## §1 前提整理

### 1.1 本リポジトリの現在地(レビュー V/RV との対応)

8 手法レビュー §2.1 の通り、ハーネス(HE)・エージェンティックエンジニアリング(AE)・
評価(EV)の基盤は既に高水準にある。ここでは [HR] のハイブリッド構成と重なる箇所だけを
再掲する:

| 領域 | 現状 | [HR] が提案する Python 側の対応物 |
|---|---|---|
| チャット・オーケストレーション | `@vaz/agents` `createChatAgent`(AI SDK v7 `streamText` + `stopWhen` + `prepareStep` + `toolApproval`)。防御は R5.2/R5.3/R5.5 まで配線済み | Pydantic AI `Agent` + `VercelAIAdapter.dispatch_request()`([HR] §1.1) |
| HITL | `needsApproval` + `createToolApprovalPolicy` + `RECIPIENT_ALLOWLIST` の独立 2 ゲート | `requires_approval=True` + フロント `addToolOutput()`([HR] §1.1) |
| RAG 取り込み | `packages/rag/src/ingest`: テキスト系 3 拡張子のみ。embedding は `createEmbedder` が単一ライターとして provenance(provider/model/dim)を刻み、`assertNoProviderMixing` が混在を拒否。**次元は DDL 固定 768** | LlamaParse / Docling による PDF・図表の構造保持パーシング([HR] §1) |
| RAG 評価 | tier1 ユニット評価 + tier3 LLM judge(`@vaz/evals`)。**忠実性(ハルシネーション有無)の回帰監視は無い** | LlamaIndex Faithfulness / Relevancy 評価モジュール([HR] §3.2)、PR ごとの CI ゲート(§3.3) |
| 文書生成の検証 | 無し(V-7 / RV-7 で計画済み) | Doer-Verifier 分離([HR] §3.4) |
| スキーマ境界 | Zod v4 単一(`@vaz/schemas` が leaf)。言語境界は存在しない | Pydantic → OpenAPI → TS 型自動生成の一方向フロー([HR] §1.2) |

### 1.2 `pydantic-ai-sandbox` から再利用できる資産

sandbox は「パターン集」であり、そのまま import する対象ではないが、**設計・規律・契約の
移植元**として次が使える:

| sandbox 資産 | 内容 | 本計画での使い方 |
|---|---|---|
| `patterns/rag/`(RAG レーン) | LlamaIndex 役割分担(Docling `HybridChunker` → `VectorStoreIndex` → top-k → 引用検証)。`chunk_id` 接地キー、dangling/empty 引用の loud-fail、決定論シーム(tokenizer / embed_model DI) | Phase B のパーシング API の設計原型。`locator`(page→section→char、ADR-4)規約は PDF 由来チャンクの引用表示に必要 |
| `patterns/sse/` | FastAPI + sse-starlette、判別共用体イベント契約、切断時のリソース解放、`httpx.ASGITransport` によるネットワークゼロ検証 | Python サービスの FastAPI 実装規律(テスト戦略含む)。Phase C に進む場合の SSE 中継の下敷き |
| `patterns/hitl/` | stop/approve/resume ハーネス、`SessionStore` 予算累積、閉じた `stop_reason` 語彙 | Phase C の採用判断材料(`needsApproval` ↔ `requires_approval` 写像の実証コード) |
| `patterns/contracts/` + ドリフトテスト | 依存ゼロの契約パッケージと「文書内コードブロック = 正本」を 1 点検証するドリフトテスト | §3.3 のスキーマ単一情報源の CI 検証方式として同型を採る |
| `EVAL-GRADERS.md` / `eval_graders.py` | outcome/behavior 分離、離散 Rating + `unknown`、judge 注入シーム | Phase A の忠実性評価の出力契約を `@vaz/evals` の既存 3 層と整合させる際の写像元 |
| レーン運用規律 | uv 独立レーン、pyright strict、mise 経由ゲート、`block_network` ユニットテスト | `services/agent` の開発規律をゼロから決めずに移植 |
| NR-1(MCP レーン計画) | annotations ↔ `requires_approval` 写像表、供給網審査 | RV-6(MCP ポジション ADR)の内容に取り込む |

### 1.3 [HR] の主張のうち、本リポジトリで既に満たされているもの

[HR] を全面採用する必要がないことの根拠として明示する:

- [HR] §2(5 大ワークフローパターン、ワークフロー/エージェント判断基準)—
  supervisor は「コードがフローを決める」型付きワークフローで LE-5 準拠済み。
- [HR] §3.1 フェーズ 0〜3(評価の早期整備)— 3 層評価と nightly ベースラインは存在。
  欠けているのは**忠実性軸**と**本番還流**(V-4)で、これが Phase A の対象。
- [HR] §4(Work in Public / 権限モデル)— 運用論であり本設計の範囲外。ただし
  「エージェントは NHI として監査ログに帰属させる」([HR] §5.2/§6 フェーズ 4)は
  既存の audit 単一発火点 + `runtimeContext` 設計と同方向であり、矛盾しない。
- [HR] §5(MCP 脅威モデル)— 現状ツールは in-process 2〜3 種で MCP 不採用が妥当
  (V-6)。ADR 化(RV-6)の際に [HR] §5.1 の 4 脅威と §5.2 のポリシー例を参照する。

---

## §2 選択肢の比較と判断

| | A: TS 単独強化(現行計画のみ) | **B: Python サイドカー(推奨)** | C: フルハイブリッド([HR] §1 原型) |
|---|---|---|---|
| 構成 | RV-1..RV-7 のみ実施。Python 導入なし | チャット/ジョブ本線は VAZ のまま。`services/agent`(FastAPI)を**ステートレスな解析・評価サービス**として追加 | チャット本線を Pydantic AI + `VercelAIAdapter` へ移行。Next.js は BFF プロキシ化 |
| PDF・複雑文書 ingest | 不可(TS に Docling/LlamaParse 同等が薄い) | ○ Docling/LlamaParse を Python 側で | ○ 同左 |
| RAG 忠実性の CI ゲート | 自作 judge の拡張のみ(LlamaIndex Faithfulness 相当の再発明) | ○ LlamaIndex 評価モジュールをそのまま | ○ 同左 |
| 実装済み防御の扱い | 温存 | **温存**(チャット経路に変更なし) | sticky taint(R5.3)・監査フック・承認ポリシー・allowlist を Python へ再実装。`VercelAIAdapter` の既定サニタイズ([HR] §1.1 注意点 1)と R5.2 の関係も再設計 |
| 運用負荷 | 増なし | 中(ステートレス 1 サービス追加。DB/Redis 接続なし) | 大(認証境界の二重化 [HR] §1.1 注意点 2、デプロイ 2 系統、障害面の拡大) |
| リスク | 機会損失(忠実性評価・PDF 対応の遅延) | 低〜中(境界契約のドリフトが主リスク → §3.3 で対策) | 中〜高(防御の再実装は退行の温床。移行中の二重メンテ) |

**判断**: B を採用する。理由:

1. [HR] のハイブリッド分離の動機は「TS で UX、Python で高度なデータ処理・評価」([HR] §1)
   であり、**オーケストレーションまで Python に移すことは要求していない**。[HR] §1 の表でも
   オーケストレーション層は TS 側に置かれている。本リポジトリはオーケストレーション層が
   既に TS で完成しているため、境界を「データ・評価処理」に引くのが [HR] の趣旨に最も忠実。
2. C で失うもの(実装済みの R5.x 防御、エンジン非依存 seam、`MockLanguageModelV4` による
   ネットワーク不要テスト網)は、C で得るもの(Pydantic AI のイディオム)に対して大きい。
   sandbox の HITL/SSE レーンが示す通り Python 側でも同等品質は**作れる**が、それは
   「二度作る」ことであり、いま払う理由がない。
3. B は C への**片道切符ではない**。B で導入する FastAPI サービス・契約 CI・運用規律は、
   将来 C に進む場合の土台をそのまま構成する(§5 Phase C 採用条件)。

---

## §3 採用アーキテクチャ(選択肢 B の設計)

### 3.1 リポジトリ配置

[HR] §1.3 のリファレンス構成を本リポジトリの既存規約に合わせて縮約する:

```text
services/
  agent/                      # Python サービス(FastAPI + Pydantic AI + LlamaIndex)
    app/
      main.py                 # FastAPI 組み立て(composition root)
      config.py               # env 検証(pydantic-settings)。モデル ID 唯一の許可場所(§3.4)
      parsing/                # Phase B: Docling/LlamaParse → 構造保持チャンク
      evals/                  # Phase A: Faithfulness / Relevancy 評価ハーネス
      observability/          # OTel(logfire は任意)。gen_ai.* スパン規約は TS 側と揃える
    tests/                    # pytest。ネットワークゼロ(sandbox の block_network 規律を移植)
    pyproject.toml            # uv 管理。pyright strict(sandbox と同一水準)
packages/
  schemas/src/generated/      # OpenAPI から生成した境界型(§3.3。生成物・手書き禁止)
.github/workflows/evals.yml   # PR ごとの評価スイート([HR] §3.3。既存 nightly と統合)
```

- `services/agent` は **`@vaz/*` の依存グラフの外**に置く(TS パッケージから import
  されない・しない)。接続は HTTP 境界のみ。`apps/worker` ↔ `apps/web` の関係のような
  ソース共有はしない。
- mise に `mise run py:check`(uv sync + ruff + pyright + pytest)を追加し、
  既存 `mise run check` からは独立させる(Python 未導入環境で TS ゲートが壊れないこと)。

### 3.2 データフロー — 「解析は Python、書き込みは TS」の単一ライター原則

**Python サービスは DB を持たない・触らない。** これが本設計の中心的な決定である。

```
Phase B(取り込み):
  PDF/DOCX ──POST /parse──▶ services/agent(Docling/LlamaParse)
      ◀── 構造保持チャンク JSON(source/locator/ordinal/text)──┘
  packages/rag ingest CLI ──(既存 createEmbedder + assertNoProviderMixing)──▶ pgvector

Phase A(評価):
  @vaz/evals nightly ──POST /eval/faithfulness {question, contexts, answer}──▶ services/agent
      ◀── {faithfulness, relevancy, verdict, judge_model, cost} ──┘
```

理由:

- **768 次元 DDL 固定と provenance 混在拒否(R2.2/2.3)を無傷で保つ。** embedding の
  書き込み経路が `packages/rag/src/ingest` の 1 箇所のままなら、Python 側が別の
  embedding モデルで汚染する事故が構造的に起きない。Python 側で embedding まで行う案は、
  provider/model/dim の provenance 文字列を 2 言語で一致させ続ける保守を生むため退ける。
- Python サービスがステートレスになり、DB マイグレーション・コネクションプール・
  Redis 購読が一切不要。デプロイは「HTTP を待つプロセス 1 個」で済む。
- 評価(Phase A)は読み取り専用の判定であり、入力は呼び出し側(TS の nightly)が
  既に持っている `GoldenCase` 実行結果をそのまま渡せる。

チャンク契約は `@vaz/schemas/rag` の `retrievedChunkSchema` を基準にしつつ、PDF 由来の
位置情報のため sandbox RAG レーンの `locator` 規約(page→section→char の文書種別非依存
アンカー、sandbox ADR-4)を**追加フィールドとして**取り込む(optional、既存テキスト
ingest は不変)。

### 3.3 スキーマ単一情報源([HR] §1.2 の適用)

言語境界が生まれる箇所に限り、[HR] §1.2 の一方向フローを採る:

1. **正本は Python 側の Pydantic モデル**(`/parse`・`/eval/*` の入出力)。
2. FastAPI の OpenAPI 出力から `openapi-typescript` で
   `packages/schemas/src/generated/agent-service.ts` を生成(生成物はコミットする —
   source-only パッケージ規約と CI の再現性のため)。
3. TS 側でランタイム検証が要る箇所(nightly が受け取る評価結果など)は、生成型に
   適合する**薄い Zod を手書き**し、CI で JSON Schema 互換性テストを走らせて破壊的
   変更を検知する([HR] §1.2)。検証方式は sandbox `test_contract_drift.py` と同型の
   「1 点で全契約を照合するドリフトテスト」とする。
4. **既存の Zod 契約(chatRequestSchema、jobEvent、rag、env)は正本のまま動かさない。**
   Pydantic 正本はこの新設 HTTP 境界だけに適用する。二重定義のドリフト([HR] §1.2 が
   警告するもの)は「境界ごとに正本を 1 つに固定する」ことで避ける — リポジトリ全体を
   1 つの正本に統一することは目的ではない。

### 3.4 横断制約の扱い(既存ガバナンスの延長)

| 既存制約 | Python サービスへの適用 |
|---|---|
| モデル ID は `@vaz/config` のみ(R1.8/ADR-5、grep ゲート) | `services/agent/app/config.py` を**第 3 の免除ファイル**として `scripts/forbid-model-ids.sh` の対象拡張に追加(現免除: `model-allowlist.ts`、`schemas/src/env.ts`)。judge モデル等は env 経由 + `config.py` 内 allowlist で検証し、コード他所へのハードコードは TS 同様に禁止 |
| R4.7 プライバシー契約(raw プロンプト/ツール引数をログしない) | FastAPI アクセスログ・アプリログに評価入力(question/answer 本文)を出さない。sandbox SSE レーンの R8.3(サニタイズ済み引数のみ)と同じ規律。監査が必要な項目は呼び出し側 TS の `deps.audit` に残す(発火点を増やさない) |
| 認証境界([HR] §1.1 注意点 2) | Phase A/B の呼び出し元は nightly CI と ingest CLI(人間の運用)のみなので、公開はせず**内部ネットワーク限定 + サービス間トークン**で足りる。ブラウザから到達させない(Next.js BFF 経由にしない限りエンドユーザ経路は存在しない)。Phase C に進む場合のみ JWT 検証ミドルウェアが必須になる |
| 供給網ゲート(`allowBuilds` / `minimumReleaseAge`) | Python 側は uv lock + 依存監査(pip-audit、sandbox の manual ステージと同型)で対応。思想(「audited な明示的許可」)を揃える |
| fail-soft テレメトリ | OTel 計装は `observability/` に隔離し、初期化失敗でサービスを落とさない。スパン属性は TS 側 `gen_ai.*` 規約と揃え、`jobId`/`caseId` で両言語のトレースを突き合わせ可能にする(AO-1) |

### 3.5 評価ゲートの CI 統合([HR] §3.3 × RV-4)

- 既存 nightly(tier3 judge + コストキャップ)に **tier2: RAG 忠実性**を追加する。
  実行体は TS の nightly runner のまま、判定だけ `/eval/faithfulness` へ委譲する。
- PR ゲート([HR] §3.3 の 3 指標: 合格率前回比 / トリガーバランス / ケース平均コスト)
  は `evals.yml` として新設するが、**閾値ブロックは golden set が RV-4 で 20 件以上に
  拡充されてから有効化**する(少数ケースでの閾値ゲートはノイズでマージを止めるため)。
  それまではレポートのみ(non-blocking)。
- Doer-Verifier([HR] §3.4)は RV-7 の実装形として合流させる: RV-7 の第 1 段
  (機械検証: 引用参照の存在チェック)は TS 内で完結、第 2 段の LLM verifier を
  `/eval/*` 経由の opt-in にする。**Verifier には Doer の会話履歴を渡さず、成果物と
  受け入れ基準のみを渡す**([HR] §3.4 実装指針)— これは現行 `gradeRun` の設計とも
  一致しており、Python 側でも同じ制約を契約に固定する。

---

## §4 フェーズ計画(Exit Criteria 付き)

RV-1..RV-7 の優先順位は不変。本計画(PL-x)は並走トラックとして挿入する。

| フェーズ | 内容 | 目安 | Exit Criteria |
|---|---|---|---|
| **前提**(TS 内、既計画) | RV-1(system プロンプト)・RV-2(予算/停止理由監査)を先行着地 | 既定 | RV-1/RV-2 の受け入れ条件どおり |
| **PL-1**(Phase A: 評価サイドカー) | `services/agent` 新設(uv/pyright strict/pytest ネットワークゼロ)。`/eval/faithfulness`・`/eval/relevancy` 実装。§3.3 の契約生成 + ドリフトテスト。nightly に tier2 を接続(non-blocking レポート) | 〜3 週 | nightly が忠実性/関連性スコアをケース毎に出力し、契約ドリフトテストが CI で通ること。`mise run py:check` が green |
| **PL-2**(Phase B: 取り込み強化) | `/parse` 実装(Docling `HybridChunker` 基本、LlamaParse は API キー前提の opt-in)。`locator` optional フィールド追加(スキーマ/DDL 後方互換)。ingest CLI に `--via-parser` 経路追加(既存 3 拡張子の経路は byte 互換) | 〜3 週 | PDF コーパスを ingest → チャットで引用に locator が表示されるまで E2E で確認。`assertNoProviderMixing` に抵触しない(embedding 書き込みは TS 単一ライターのまま)ことをテストで固定 |
| **PL-3**(評価ゲート有効化) | RV-4 の golden set 拡充(≥20 件)後、`evals.yml` の 3 指標閾値ブロックを有効化([HR] §3.3)。RV-7 の LLM verifier を `/eval` に合流 | RV-4 完了後 | 閾値未達 PR がマージブロックされること。オーバー/アンダートリガー両側の測定([HR] §3.1 フェーズ 3)がレポートに含まれること |
| **PL-4**(MCP ADR 合流) | RV-6 の ADR に [HR] §5.1(4 脅威)・§5.2(ポリシー例)と sandbox NR-1(annotations ↔ 承認写像)を取り込む。文書のみ | S | ADR に「採用条件」「写像表」「供給網審査」が含まれ CLAUDE.md から辿れること |
| **Phase C**(条件付き・非着手) | チャット本線の Pydantic AI + `VercelAIAdapter` 移行 | — | 下記採用条件を満たすまで着手しない |

### 依存関係

```
RV-1, RV-2(既計画・先行)
PL-1 ──▶ PL-3(ゲート有効化は golden set 拡充 = RV-4 と合流後)
PL-2(PL-1 と独立。ただしサービス骨格は PL-1 で先に立つ)
PL-4(文書のみ・独立。RV-6 と同一成果物)
Phase C(採用条件成立時のみ。PL-1/2 のサービス・契約 CI が土台になる)
```

## §5 Phase C(フルハイブリッド)の採用条件と移行コスト台帳

以下の**いずれかが要件として確定**するまで着手しない:

1. deep-research 型のマルチエージェント調査(sandbox `patterns/deep-research` 相当)を
   本番のチャット/ジョブ本線に載せる要件が出た(Python 資産の直接利用が本線価値になる)。
2. LlamaIndex のクエリエンジン(ハイブリッド/グラフ RAG)を**応答経路内で**使う要件が
   出た(現状の pgvector top-k で品質要件を満たせない実測が出た)。
3. ツール群が外部 SaaS 中心になり、Python 側 MCP クライアント(RV-6 ADR の採用条件と
   同時成立)で統合する方が総コストが低いと判断された。

着手時に必ず移植・再設計する項目(逆に言えば C の見積りの本体):

- system プロンプト(RV-1 成果)と R5.2 デリミタ規約 → Pydantic AI の
  system/instructions への写像。`VercelAIAdapter` の既定サニタイズ([HR] §1.1 注意点 1)
  は**無効化しない**前提で R5.2 と重複整理。
- sticky taint(R5.3)— Pydantic AI に既製の等価物なし。run スコープの状態として
  自前実装(sandbox HITL レーンの `SessionStore` 状態機械が参考実装)。
- 監査単一発火点(R5.5/R4.7)と `needsApproval` ↔ `requires_approval` +
  `addToolOutput()` の写像、`RECIPIENT_ALLOWLIST` の移植(committed-code 原則維持)。
- 認証: FastAPI 前段の JWT 検証([HR] §1.1 注意点 2)+ Next.js `route.ts` の
  BFF プロキシ化([HR] §1.3)。
- E2E: `MockLanguageModelV4` 相当のネットワーク不要ハーネスを Python 側に用意
  (sandbox の決定論フェイク群が原型)。

## §6 非採用事項(明示)

- **リポジトリ全体のスキーマ正本を Pydantic に統一すること** — 境界単位の正本固定で足りる
  (§3.3)。既存 Zod/drizzle-zod 契約は動かさない。
- **Python サービスからの DB 直接書き込み** — 単一ライター原則(§3.2)に反する。
- **チャット応答経路への Python 挿入(現時点)** — §5 の条件成立まで保留。
- **LlamaParse の必須化** — 外部 SaaS 送信を伴うため opt-in(env キー存在時のみ)。
  既定は Docling(ローカル実行)。機密文書の扱いは [HR] §4.1 のセキュリティ境界の
  考え方に従い、コーパス投入前に持ち主が判断する。
- **[HR] §5.3 Managed Agents / §4.2 アクセスバンドル** — 本リポジトリのスコープ外の
  運用基盤選定。RV-6 ADR で参照のみ。

---

## §7 まとめ

[HR] のハイブリッド構成は「二極化」を目的にしたものではなく、**各言語圏の強みへ処理を
寄せる**ための構成である。本リポジトリは TS 側(ストリーミング UX・オーケストレーション・
HITL・監査)が既に [HR] の要求水準を満たしているため、導入すべきは Python 側の強み —
**LlamaIndex/Docling の文書解析と Faithfulness/Relevancy 評価** — に絞られる。
これをステートレスなサイドカー(`services/agent`)として、単一ライター原則(§3.2)と
OpenAPI 一方向生成(§3.3)で既存ガバナンスに接続する。`pydantic-ai-sandbox` は
その実装規律(レーン構成・契約ドリフトテスト・決定論テスト・HITL 状態機械)の移植元として
機能し、フルハイブリッド(Phase C)は採用条件と移行コスト台帳(§5)を先に固定した上で
保留する — これが 3 文書の要求を最小の二重実装で満たす構成である。
