# Agentic AI 業務適用ベストプラクティス設計 — 8手法レビューとリファクタリング計画

対象: 本リポジトリ全体(`apps/web` / `apps/worker` / `packages/*`)

- **検証日**: 2026-07-16
- **対象コミット**: `d583ab3`(`claude/agentic-ai-best-practices-csth1r` 分岐点)
- **目的**: Agentic AI の業務適用設計で参照される 8 つのエンジニアリング手法
  (プロンプト/コンテキスト/ループ/ハーネス/エージェンティック・エンジニアリング、
  AgentOps、MCP、エージェント評価)を IBM・Anthropic の技術情報で裏取りし、
  検証したベストプラクティスに対して本リポジトリの設計を評価、
  リファクタリング計画を優先度順に設計する。
- **検証方法**: 出典は Web 検索でタイトル・要旨・到達性を確認(2026-07-16 時点)。
  `anthropic.com` / `ibm.com` は本セッションのネットワークポリシーで本文の直接取得が
  不可のため、内容は検索スニペットと既知の一次情報に基づく。リポジトリ側は
  実コード(`packages/agents/src/*` ほか)を直接照合した。

---

> **状態注記(2026-07-26、spec 005 R4.6)**: §2.2 の V-1〜V-7 と §3 の RV-1〜RV-7 は
> spec 002(`002-pydantic-enhance` に先行する agentic-ai-best-practices 実装)で
> **すべて消化済み**である。根拠は各表内の「解消」列を参照。本ドキュメントの §1
> (8 手法の一次情報レビュー)は今も有効な参照資料として不変。§2.2/§3 の現在形の
> 「ギャップ」表記は、消化が完了した時点の**履歴記録**として読むこと(次の棚卸しは
> `specs/005-baseline-recovery-refactor/spec.md` の台帳を出発点にする)。

## 出典(一次情報)

本文中は出典 ID(`[A1]` 等)で引用する。

### Anthropic

| ID | タイトル | URL |
|---|---|---|
| [A1] | Building Effective AI Agents | https://www.anthropic.com/engineering/building-effective-agents |
| [A2] | Effective context engineering for AI agents | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| [A3] | Effective harnesses for long-running agents | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| [A4] | Writing effective tools for AI agents — using AI agents | https://www.anthropic.com/engineering/writing-tools-for-agents |
| [A5] | Demystifying evals for AI agents | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents |
| [A6] | Code execution with MCP | https://www.anthropic.com/engineering/code-execution-with-mcp |
| [A7] | Prompt engineering overview(Claude Docs) | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview |
| [A8] | Model Context Protocol(Anthropic 発の公開標準) | https://modelcontextprotocol.io / https://www.anthropic.com/news/model-context-protocol |
| [A9] | How we built our multi-agent research system | https://www.anthropic.com/engineering/multi-agent-research-system |

### IBM

| ID | タイトル | URL |
|---|---|---|
| [I1] | What is AgentOps? | https://www.ibm.com/think/topics/agentops |
| [I2] | What Is Context Engineering? | https://www.ibm.com/think/topics/context-engineering |
| [I3] | Context engineering for trusted agentic AI | https://www.ibm.com/think/insights/context-engineering-foundation-trusted-ai |
| [I4] | What is Model Context Protocol (MCP)? | https://www.ibm.com/think/topics/model-context-protocol |
| [I5] | What is prompt engineering? | https://www.ibm.com/think/topics/prompt-engineering |
| [I6] | AI agent evaluation | https://www.ibm.com/think/topics/ai-agent-evaluation |
| [I7] | How to know if your AI agents are working as intended(IBM Research) | https://research.ibm.com/blog/ibm-agentops-ai-agents-observability |
| [I8] | What Are AI Agents? / What is Agentic AI? | https://www.ibm.com/think/topics/ai-agents / /agentic-ai |

### 補助出典(用語の初出がコミュニティ側のもの)

| ID | タイトル | URL |
|---|---|---|
| [C1] | Addy Osmani, "Agentic Engineering" / "Loop Engineering"(2026-06) | https://addyosmani.com/blog/agentic-engineering/ |

> 「ループエンジニアリング」「エージェンティックエンジニアリング」は Anthropic / IBM が
> 同名の文書を公刊している用語ではない(2026-07 時点)。ただし中身は Anthropic の
> エージェントループ(gather context → take action → verify → repeat)[A1][A2] と
> ガードレール設計 [A1]、および人間が設計・品質を所有する開発規律 [A1][A5] に
> 対応するため、本レビューでは両者を一次情報に還元して定義する。

---

## §1 調査 — 8 手法の定義と検証済みベストプラクティス

8 手法は独立した流行語ではなく、**階層**として整理できる:
プロンプト ⊂ コンテキスト ⊂ ループ ⊂ ハーネス ⊂ エージェンティックエンジニアリング
(内側から外側へスコープが広がる)。AgentOps は運用横断、MCP は接続標準、
評価は品質保証としてこの階層を貫く。

### 1.1 プロンプトエンジニアリング (PE)

1回のモデル呼び出しに与える指示文の設計 [A7][I5]。エージェント時代の位置づけは
「コンテキストエンジニアリングの部分集合(初期の書き方)」[A2]。

- **PE-1** 明確・直接的な指示。役割は system プロンプトで与える(role prompting)[A7]。
- **PE-2** 構造化: XML タグ等の明示的デリミタで指示・データ・例を分離する [A7]。
  信頼できないデータはデリミタで括り「指示ではない」と明示する [I3]。
- **PE-3** 適切な「高度」: 具体すぎる if-else 的ハードコードは脆く、曖昧すぎる指示は
  シグナル不足。ヒューリスティックを与える高度が最適 [A2]。
- **PE-4** プロンプトはコードとして扱う: バージョン管理・単一ソース・ユニットテスト
  (判定プロンプトも含む)[A5]。
- **PE-5** ツールの description もプロンプトである: 「いつ呼ぶか」を規範的に書く。
  記述の小さな改善が性能を劇的に変える [A4]。

### 1.2 コンテキストエンジニアリング (CE)

推論時にモデルが見る**トークン全体**(system・ツール定義・履歴・検索結果・例)の
構成最適化 [A2][I2]。LLM には有限の「attention budget」があり、コンテキストが
伸びるほど劣化する(context rot)ため、「望む結果の尤度を最大化する最小の高信号
トークン集合」を維持する [A2]。

- **CE-1** Just-in-time 検索: 全データの事前注入でなく、ツールによる実行時取得 [A2]。
- **CE-2** Compaction: 上限接近時に履歴を要約し再初期化する [A2]。
- **CE-3** Structured note-taking: コンテキスト外の永続メモ(外部メモリ)に要点を
  書き出し、必要時に読み戻す [A2]。
- **CE-4** サブエージェント分離: 深い探索は独立コンテキストのサブエージェントに任せ、
  凝縮した要約だけを親へ返す [A2][A9]。
- **CE-5** 信頼境界: 出所(provenance)を管理し、信頼できないコンテンツを system の
  権威と混ぜない。ガバナンスされたコンテキストが信頼できるエージェントの基盤 [I3]。

### 1.3 ループエンジニアリング (LE)

エージェントループ(コンテキスト収集 → 行動 → **検証** → 反復)の制御系の設計
[A1][C1]。人間がターン毎にプロンプトを打つのではなく、トリガ・検証器・リトライ・
停止規則を設計する。

- **LE-1** 停止条件は多重に: ステップ数だけでなくトークン/コスト予算・時間で有界化
  する。エラーは複利で増えるため [A1]。
- **LE-2** 停止理由(stop reason)を閉じた語彙で監査可能にする [A1][I1]。
- **LE-3** 検証器をループに組み込む: ルール → コード検証 → LLM 判定の順に安価な
  ものから。evaluator-optimizer は代表パターン [A1]。
- **LE-4** ガードレール: 最小権限のツール allow-list、破壊的操作の人間チェック
  ポイント(HITL)[A1]。
- **LE-5** 制御フローが予測可能でよいならワークフロー(コードがフローを決める)を
  選び、エージェント(LLM がフローを決める)は必要な所だけ [A1]。

### 1.4 ハーネスエンジニアリング (HE)

モデルの周囲の足場 — ツール実行、状態管理、環境、復旧 — の設計 [A3]。
長時間・複数コンテキストウィンドウにまたがる作業では特に、ハーネスが
「進捗の一貫性」を担保する。

- **HE-1** 初期化と実行を分離する(initializer / coder の二相)。最初のコンテキスト
  ウィンドウで環境と作業定義を整備し、以後はそれを参照する [A3]。
- **HE-2** 構造化した作業リスト(例: JSON の feature list)を「正」とし、モデルの
  記憶でなく成果物で進捗を管理する [A3]。
- **HE-3** 進捗ノート・チェックポイント(git コミット等)で、いつでも巻き戻し・
  再開できるようにする [A3]。
- **HE-4** 完了宣言の前に検証を強制する(テスト実行など)[A3]。
- **HE-5** 中断・再開(suspend/resume)は害ネス側の永続機構が所有し、モデルは
  型付き契約で関与する [A3]。
- **HE-6** ハーネスに向けたツール形状: 破壊的操作は専用ツール化して型付き引数を
  ゲート・監査・描画できるようにする [A4]。

### 1.5 エージェンティックエンジニアリング (AE)

エージェントと共に/エージェントの上に構築する開発規律 [C1]。
「AI が実装し、人間がアーキテクチャ・品質・正しさを所有する」。
vibe coding(レビューなしで受け入れる)との対比で定義される。

- **AE-1** シンプルに始める: フレームワークの重い抽象より、合成可能な最小
  プリミティブで組む [A1]。
- **AE-2** 仕様・ADR・受け入れ条件を先行させる(spec-driven)。エージェントへの
  コンテキストファイル(CLAUDE.md / AGENTS.md)を整備し実態と乖離させない [C1]。
- **AE-3** 機械的ゲート(lint・型・テスト・grep ゲート・フック)で「人間のレビューが
  最後の砦」にならないようにする [C1]。
- **AE-4** ACI(Agent-Computer Interface)を人間向け UI と同格の設計対象にする [A1][A4]。

### 1.6 AgentOps (AO)

自律エージェントのライフサイクル管理の実践体系。DevOps / MLOps の後継で、
**可観測性・評価・最適化**の 3 本柱 [I1][I7]。

- **AO-1** セッション/トレース/スパンの 3 層で計装する(OTel GenAI 準拠)[I1][I7]。
- **AO-2** コスト・レイテンシ・ループ段数・ツール失敗率をメトリクス化し、
  ドリフトを監視する [I1][A5]。
- **AO-3** 監査証跡(誰が・どのツールを・どの引数で)とガバナンス(HITL、KPI 追跡)
  をライフサイクル全体に適用する [I1]。
- **AO-4** 本番の障害を評価セットへ還流する(観測 → 評価 → 最適化のループ)[I1][A5]。
- **AO-5** デプロイ前のサンドボックス評価と、本番での継続評価を分けて両方持つ [I1]。

### 1.7 Model Context Protocol (MCP)

エージェントと外部ツール/データ源を繋ぐオープン標準(Anthropic 発、2024-11 公開)
[A8]。IBM は「AI アプリの USB-C ポート」と形容し、エージェントフレームワークでは
なく**標準化された統合レイヤ**と位置づける [I4]。

- **MCP-1** 採用判断: 統合を複数ホスト/複数エージェントで再利用するとき、または
  サードパーティのツール群を取り込むときに価値が出る。単一アプリ内の少数ツール
  なら in-process 定義で足りる [I4][A4]。
- **MCP-2** ツールセットの肥大に注意: 人間がどれを使うか即答できないツール群は
  エージェントにも選べない。名前空間・厳選・遅延ロードで抑制する [A4]。
- **MCP-3** tool annotations(readOnlyHint / destructiveHint 等)で破壊性を宣言し、
  ホスト側の承認ポリシーに接続する [A8]。
- **MCP-4** 大規模ツールセットではコード実行経由の MCP 呼び出しでトークンを節約
  する(中間結果をコンテキストに入れない)[A6]。
- **MCP-5** セキュリティ: MCP サーバは供給網として審査する。ツール結果は信頼
  できない入力としてプロンプトインジェクション対策の対象にする [I4][I3]。

### 1.8 エージェント評価 (EV)

エージェントの有用性を作る能力(自律性・多段行動)は評価を難しくする。
それでも評価は自動化された第一防衛線である [A5][I6]。

- **EV-1** 実タスク・実障害から 20〜50 件の小さなタスク集合で始める [A5]。
- **EV-2** 採点器は3系統を使い分ける: コード採点(決定論)、LLM-as-judge、人間 [A5][I6]。
- **EV-3** アウトカム(結果)とビヘイビア(過程: ツール選択・手順)を別軸で採点する [A5]。
- **EV-4** 判定者バイアスに注意: judge は独立モデル/独立プロンプトにし、judge 自体の
  コストも計上する [A5]。
- **EV-5** 自動評価・本番監視・A/B テスト・トランスクリプトレビューは補完関係で、
  開発段階ごとに使い分ける [A5][I6]。
- **EV-6** 評価はセッション/トレース/スパンの各レベルで行える(IBM AgentOps の
  評価柱と同一の構造)[I1][I6]。

---

## §2 本リポジトリの評価

### 2.1 準拠している点(強み)

| 手法 | 実装根拠 | 対応 BP |
|---|---|---|
| PE | RAG 結果を明示デリミタ+不信通知で括り `user` ロールに隔離(`packages/agents/src/prompt.ts:28-71`)。judge プロンプトは関数としてエクスポートされ単体テスト可能(`packages/evals/src/judge.ts` `buildJudgePrompt`) | PE-2, PE-4 |
| CE | RAG は `searchDocuments` ツールによる実行時取得(CE-1)。検索結果ブロックは直後の 1 ステップにのみ注入され重複注入しない(`chat-agent.ts:114-128`)。sticky taint で信頼境界を run 全体に維持(CE-5, `approval-policy.ts`) | CE-1, CE-5 |
| LE | `stopWhen: isStepCount(5)` の有界ループ。破壊的ツールは `needsApproval` 宣言+承認ポリシー+受信者 allow-list の**独立 2 ゲート**(LE-4)。supervisor は「コードが制御フローを決める」型付きワークフローで、LLM 自由連鎖にしない(LE-5, `supervisor.ts` R3.3) | LE-4, LE-5 |
| HE | ルートは薄い HTTP⇔Agent アダプタ、オーケストレーションは `@vaz/agents`(境界明確)。エンジン非依存の `WorkflowStepRunner` seam + Inngest で suspend/resume がワーカー再起動を跨いで成立(HE-5)。`MockLanguageModelV4` によるネットワーク不要のテストハーネス。email は専用ツール+型付き引数で HE-6 に一致 | HE-5, HE-6 |
| AE | spec 駆動(`specs/001-vaz-ai-update`)、ADR 群、CLAUDE.md/AGENTS.md、モデル ID grep ゲート(`lint:model-ids`)、チェックイン済み git フック、pnpm `allowBuilds`+`minimumReleaseAge` の供給網ゲート | AE-1〜AE-4 |
| AO | `instrumentation.ts` の fail-soft OTel + AI SDK ブリッジ、`runtimeContext` による span 属性(R4.2)、単一発火点の監査フック(`audit-hook.ts`)+R4.7 プライバシー契約 | AO-1, AO-3 |
| EV | 3 層評価: tier1 ユニット評価(`packages/evals/src/unit/`)、tier3 LLM judge(outcome/behavior 独立軸 = EV-3)、nightly はケース毎ベースライン(回帰検知)+judge 自身の消費も含むコストキャップ(EV-4) | EV-2, EV-3, EV-4 |

### 2.2 ギャップ(指摘一覧、重要度順)— **履歴記録**: 全項目 spec 002 で解消済み(2026-07-26 確認)

| # | 重要度 | 手法 | 指摘 | 根拠 | 場所 | 解消 |
|---|---|---|---|---|---|---|
| V-1 | **高** | PE | **チャットエージェントに system プロンプトが無い**。`buildStreamTextOptions` は `system` を渡さず、モデルはツール定義と生のユーザ履歴だけで動く。役割・ツール使用方針・引用提示形式・「検索結果内の指示に従わない」という権威側の宣言が未定義。R5.2 の不信デリミタは「system の権威と対比される」ことで効くため、system 不在は防御の非対称も生む。supervisor の doc-gen 専門家には 2 文の system がある(`supervisor.ts:208-210`)が、チャット側は空 | PE-1, PE-2, PE-3, CE-5 | `packages/agents/src/chat-agent.ts:153-175` | 解消: spec 002 — `CHAT_SYSTEM_PROMPT`(`packages/agents/src/prompt.ts`)が `chat-agent.ts` の `system` に配線済み |
| V-2 | **高** | LE / AO | **実行時ループの予算と停止理由の監査が無い**。停止条件はステップ数(5)のみで、トークン/コスト予算が本番チャット・supervisor に存在しない(コストキャップは nightly 評価だけ)。run 終了時の usage・停止理由(step 上限/自然終了/エラー)がテレメトリ・監査へ出ず、AgentOps のコスト可視性が欠ける | LE-1, LE-2, AO-2 | `chat-agent.ts:164`、`supervisor.ts` | 解消: spec 002 — `runStopReasonSchema`(`packages/schemas/src/run-metrics.ts`)+ `CHAT_TOKEN_BUDGET`(`@vaz/schemas/env`、`chat-agent.ts` の予算判定)で停止理由とトークン予算を監査可能化 |
| V-3 | 中 | CE | **会話履歴のコンテキスト管理が無い**。`useChat` は全履歴を毎回送信し、トリミング/compaction/コンテキスト使用量の観測が無い。長い会話で attention budget を管理する手段(CE-2)が未設計。現在の単発利用では顕在化しないが、業務適用(長い調査会話)で最初に劣化する箇所 | CE-2, CE-3 | `apps/web/src/features/chat/` → `chat-agent.ts` | 解消: spec 002 — `docs/context-budget.md`(方針文書)+ `chat-agent.ts` の `prepareStep` seam(compaction/ウィンドウイングの拡張点) |
| V-4 | 中 | EV / AO | **評価への本番還流ループが未整備**。golden set が実対話・実障害由来である仕組み(EV-1)、トランスクリプトレビューの運用、A/B の枠組み(EV-5)が無い。audit log は存在するが評価ケース採取の径路として定義されていない | EV-1, EV-5, AO-4 | `packages/evals/src/nightly.ts`(GoldenCase の供給源) | 解消: spec 002 — `GOLDEN_SET`(`packages/evals/src/nightly.ts`、20 件)+ 拡充手順を記した `packages/evals/README.md` |
| V-5 | 中 | AO | **AgentOps 3 本柱のうち「最適化」が薄い**。観測(OTel)と評価(evals)はあるが、コスト・レイテンシ・ループ段数・ツール失敗率のメトリクス集計、しきい値アラート、モデル/プロンプト変更時の回帰運用手順が文書化されていない | AO-2, AO-4, AO-5 | `packages/config/src/telemetry.ts`(属性はあるが集計方針なし) | 解消: spec 002 — `docs/agentops.md`(可観測性・評価・最適化の 3 本柱をリポジトリ実装へ対応づけ) |
| V-6 | 低 | MCP | **MCP 不採用の判断が記録されていない**。現状のツール 2〜3 種は in-process で妥当(MCP-1 の「単一アプリ・少数ツール」側)だが、採用条件・接続方式(AI SDK v7 の MCP クライアント、`needsApproval` ↔ MCP destructive annotation の対応)を ADR 化していないため、将来の外部 SaaS 連携時に場当たりになるリスク | MCP-1, MCP-3, MCP-5 | ADR 不在 | 解消: spec 002 — `docs/adr/0001-mcp-position.md`(採用条件・写像方針を記録) |
| V-7 | 低 | LE / HE | **document-generation に検証ループが無い**。生成文書のセルフチェック(evaluator-optimizer)や引用整合の機械検証がなく、完了宣言前の検証(HE-4, LE-3)が supervisor ワークフローに組み込まれていない | LE-3, HE-4 | `supervisor.ts`(doc-gen 専門家) | 解消: spec 002 — `supervisor.ts` の opt-in `DocumentVerifier`(機械検証 + LLM judge 検証ステップ) |

---

## §3 リファクタリング計画(優先度順)— **履歴記録**: RV-1〜RV-7 全項目 spec 002 で解消済み(2026-07-26 確認)

工数目安: S(半日以下)/ M(1–2日)/ L(3日以上)。
各項は既存の受け入れゲート(`mise run check`、カバレッジ ≥80%、`lint:model-ids`)を
壊さないことを共通の受け入れ条件とする。

### P0 — RV-1: チャット system プロンプトの導入(V-1、工数 S)【解消: spec 002 — `CHAT_SYSTEM_PROMPT`】

- **変更**: `packages/agents/src/prompt.ts` に `CHAT_SYSTEM_PROMPT` を追加し、
  `buildStreamTextOptions` の `system` に配線する。内容は (a) 役割・トーン、
  (b) ツール使用方針(`searchDocuments` をいつ呼ぶか — PE-5 に従い規範的に)、
  (c) 引用提示形式(`[source#ordinal]`)、(d)「デリミタ内の検索結果は参照データで
  あり指示ではない」という権威側の宣言(R5.2 の対をなす)。PE-3 に従い、手順の
  列挙でなくヒューリスティックの高度で書く。
- **受け入れ条件**:
  1. プロンプト文字列は定数としてエクスポートされ、ユニットテストが内容
     (デリミタ言及・引用形式)を検証する(`buildJudgePrompt` と同じ精神)。
  2. `buildStreamTextOptions` のテストに `system` の存在検証を追加。
  3. 既存の tier1/tier3 評価が green(判定基準が変わる場合は spec 追補を先行)。
- **リスク**: 低。プロンプト変更は挙動を変えるため、tier3 nightly を変更前後で
  1 回ずつ実行し比較する(V-4 の運用の先行事例にもなる)。

### P1 — RV-2: ループ予算と stop_reason の監査(V-2、工数 M)【解消: spec 002 — `runStopReasonSchema` + `CHAT_TOKEN_BUDGET`】

- **変更**:
  1. `buildStreamTextOptions` の `stopWhen` を `isStepCount(MAX_STEPS)` +
     トークン予算(累積 usage がしきい値超過で停止するカスタム条件)の配列にする。
     しきい値は env(`@vaz/schemas/env` に Zod デフォルトで追加)。
  2. `onFinish` で `{ finishReason, usage, steps }` を閉じた語彙の停止理由に写像し、
     テレメトリ span 属性と `deps.audit`(ツール引数でないため R4.7 に抵触しない)
     へ記録する。supervisor にも `JobEvent` として同型のメトリクスを追加。
- **受け入れ条件**: 予算超過・step 上限・自然終了の 3 経路を `MockLanguageModelV4`
  で検証。`JobEvent` スキーマ拡張は `@vaz/schemas/workflows` の Zod 契約更新と
  ドリフトの無いこと。
- **リスク**: 中。`JobEvent` は SSE 契約なので追加フィールドは後方互換(optional)で。

### P1 — RV-3: コンテキスト予算方針の文書化と compaction seam(V-3、工数 S+M)【解消: spec 002 — `docs/context-budget.md` + `prepareStep` seam】

- **変更**: 2 段階。(a) `docs/context-budget.md` に「履歴は全量送信、上限は
  step 数のみ」という現状と attention budget 方針(どの長さで何をするか)を明文化
  (S、即着地)。(b) `prepareStep` に履歴ウィンドウイング/しきい値 compaction の
  seam を追加する(未設定なら現挙動と等価な opt-in。CE-2 の「最も軽量な compaction
  から段階導入」に従う)。
- **受け入れ条件**: (b) は既定で byte 互換(既存テスト無変更で green)。しきい値
  発火の決定論テストを追加。
- **リスク**: (b) は要約に別モデル呼び出しを伴う場合コスト増。まず「古いツール結果の
  切り落とし」(要約なし)から入る。

### P2 — RV-4: 評価の本番還流とゴールデンセット拡充(V-4、工数 M・運用含む)【解消: spec 002 — `GOLDEN_SET` 20 件 + `packages/evals/README.md`】

- **変更**: (a) golden set を 20〜50 件へ拡充する手順を `packages/evals/README.md`
  に定義: 実対話の失敗事例 → 匿名化 → `GoldenCase` 化(R4.7 に従い audit log 経由、
  raw プロンプトのログ禁止は維持)。(b) 週次のトランスクリプトレビュー(サンプル N 件)
  と、プロンプト/モデル変更時に nightly を before/after 比較する運用をランブック化。
- **受け入れ条件**: 手順文書 + 初回拡充で最低 20 ケース。nightly がコストキャップ内で
  完走すること。
- **リスク**: 低(運用定着が本体)。

### P2 — RV-5: AgentOps ランブック(V-5、工数 S)【解消: spec 002 — `docs/agentops.md`】

- **変更**: `docs/agentops.md` を新設し、IBM の 3 本柱 [I1] に本リポジトリの実装を
  対応づける: 可観測性(OTel spans / audit log / RV-2 のメトリクス)、評価(3 層
  evals / RV-4 の還流)、最適化(コスト・レイテンシ・ループ段数のダッシュボード項目、
  しきい値、対応手順)。未実装項目は本計画の項番で参照する。
- **受け入れ条件**: 文書のみ。CLAUDE.md から辿れること。

### P3 — RV-6: MCP ポジション ADR(V-6、工数 S)【解消: spec 002 — `docs/adr/0001-mcp-position.md`】

- **変更**: ADR「MCP を現段階で採用しない理由と採用条件」を追加。採用条件の例:
  外部 SaaS ツールが 3 種を超える、複数ホスト(web/worker 以外)からツールを共有する、
  ベンダ提供 MCP サーバを使う判断をした時。採用時の設計原則も先に固定する:
  AI SDK v7 MCP クライアント経由、`needsApproval` と MCP destructive annotation の
  写像表、サーバの供給網審査(`allowBuilds` と同じ思想)、ツール結果への R5.2/R5.3
  防御の適用 [MCP-3, MCP-5]。
- **受け入れ条件**: 文書のみ。

### P3 — RV-7: document-generation の検証ステップ(V-7、工数 M)【解消: spec 002 — `supervisor.ts` の opt-in `DocumentVerifier`】

- **変更**: supervisor に任意の evaluator ステップを追加できるようにする
  (`options.specialists` の拡張、または doc-gen 内の出力検証)。最初は機械検証
  (引用参照の存在チェック、フォーマット準拠)から入り、LLM judge(`@vaz/evals` の
  `gradeRun` を流用)は opt-in にする [LE-3 の「安価な検証器から」]。
- **受け入れ条件**: 既定挙動は不変(検証ステップ未設定なら現行と等価)。
  検証失敗時の `JobEvent` 追加は RV-2 の語彙に載せる。

### 依存関係と着地順

```
RV-1(P0・独立)────────── 即着地
RV-2(P1)→ RV-5(RV-2 のメトリクスがランブックの実体)
RV-3(a) → RV-3(b)(方針文書が seam 設計の前提)
RV-4(P2・独立、RV-1 の before/after 比較が初回運用)
RV-6(P3・文書のみ・独立)
RV-2 → RV-7(停止理由/イベント語彙を先に固定)
```

---

## §4 まとめ

本リポジトリは **ハーネス(HE)・エージェンティックエンジニアリング(AE)・評価(EV)
の基盤が既に高水準**にある(エンジン非依存 seam、HITL 2 ゲート、3 層評価、供給網
ゲート)。ギャップは (1) プロンプト層の欠落(system 不在)、(2) ループの
コスト予算・停止理由監査、(3) コンテキスト予算とAgentOps「最適化」柱の未整備に
集約され、いずれも既存の seam(`buildStreamTextOptions` / `deps.audit` /
`prepareStep`)へ追加する形で、破壊的変更なしに導入できる。
