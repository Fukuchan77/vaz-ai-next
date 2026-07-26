# ADR-0001: Model Context Protocol (MCP) の採用ポジション

- **Status**: Accepted（非採用を現時点の結論として記録。採用条件成立時に再評価）
- **Date**: 2026-07-19
- **仕様根拠**: Req 6.2, 6.3（`specs/002-pydantic-enhance/spec.md`）、V-6/RV-6
  （[`docs/agentic-engineering-review.md`](../agentic-engineering-review.md) §2.2/§3）、
  PL-4（[`docs/pydantic-llamaindex-fastapi-enhancement.md`](../pydantic-llamaindex-fastapi-enhancement.md) §4）

散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

---

## Context

本リポジトリのツール群は現在 2〜3 種（`searchDocuments`、`getCurrentTime`、`sendEmail`）で、
すべて `@vaz/tools` の in-process 定義（`tool({ inputSchema, execute })`）として `@vaz/agents`
の `createChatAgent` / `createSupervisorWorkflow` に直接組み込まれている。Model Context
Protocol（MCP）は複数ホスト・複数エージェント間でツール/データ源を再利用するための接続標準
だが、単一アプリ内の少数ツールという現状には過剰な抽象化であり、
[`docs/agentic-engineering-review.md`](../agentic-engineering-review.md) の指摘 V-6 が記録した
とおり「MCP 不採用の判断が記録されていない」ことそのものがギャップだった。本 ADR はその判断を
明文化し、将来の採用条件・設計原則を先に固定する。

## Decision

**現時点では MCP を採用しない。** 既存 2 ゲート方式— `needsApproval`（`@vaz/tools` のツール定義側
の破壊性宣言）+ `createToolApprovalPolicy`（`@vaz/agents/src/approval-policy.ts`、HITL 承認ポリシー）
と、`RECIPIENT_ALLOWLIST`（`packages/tools/src/allowlist.ts`、コミット済み受信者許可リスト）の
独立 2 ゲート — を in-process ツール定義の上でそのまま運用する。

**根拠**:

- ツールセットの規模・再利用範囲が MCP-1 の採用判断基準（「統合を複数ホスト/複数エージェントで
  再利用するとき、またはサードパーティのツール群を取り込むとき」
  [`docs/agentic-engineering-review.md`](../agentic-engineering-review.md) §1.7）に達していない。
  `apps/web` と `apps/worker` はいずれも同一 `@vaz/tools` パッケージを直接 import しており、
  「複数ホストでの共有」を MCP サーバ経由で解決する必要が生じていない。
- in-process 定義は型（Zod `inputSchema`）・承認ポリシー・監査フック（`audit-hook.ts` の単一
  発火点）が同一プロセス内のコード参照で閉じており、MCP サーバをまたぐ供給網審査・トランス
  ポート層のセキュリティ（後述の脅威モデル）を追加で引き受ける理由が現状ない。
- MCP-2（ツールセット肥大への注意）の裏側として、少数ツールを無理に MCP 化すると
  名前空間・遅延ロードの運用コストだけが増える。

## Adoption Criteria

次のいずれかが成立した時点で、本 ADR を再評価し MCP 採用を具体化する
（[`docs/pydantic-llamaindex-fastapi-enhancement.md`](../pydantic-llamaindex-fastapi-enhancement.md)
§5 のフルハイブリッド移行条件とは別軸 — MCP のみを対象とする条件）:

1. **外部 SaaS ツールが 3 種を超える。** 現在の 2〜3 種（うち外部 SaaS 相当は `sendEmail` のみ）
   から増え、個別 in-process 定義の保守コストが名前空間・遅延ロードの恩恵を上回る規模になったとき。
2. **複数ホストでツールを共有する。** `apps/web`/`apps/worker` 以外の実行環境（例: 別チームの
   エージェント、社内の別アプリ）が同じツール群を再利用する必要が生じたとき — MCP-1 の
   「複数ホスト/複数エージェントでの再利用」が文字通り成立する場合。
3. **ベンダ提供 MCP サーバを使う判断をしたとき。** 自前でツールを実装するより、ベンダが公開する
   MCP サーバ（例: SaaS ベンダ公式の MCP エンドポイント）に接続する方が保守コストで有利と
   判断される場合。

## Design Principles Fixed In Advance

採用条件が成立してから設計するのではなく、採用時に踏むべき原則を今のうちに固定する
（PL-4、Req 6.2）。

### 1. AI SDK v7 MCP client 経由

AI SDK v7 の MCP 統合は `@ai-sdk/mcp` パッケージの `createMCPClient()` で、stdio
（`Experimental_StdioMCPTransport`）・HTTP・SSE の 3 トランスポートを持つ。`client.tools()` が
MCP ツールを AI SDK の `tool()` 形状へ自動変換して返すため、`createChatAgent` /
`createSupervisorWorkflow` の既存 `tools` 引数に合成できる（新たなツール実行経路を増設しない）。
自前の SSE 実装や独自プロトコルクライアントは書かない。

### 2. `needsApproval` ↔ MCP destructive-annotation 写像表

MCP のツール定義は `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`
の 4 annotation を持つ（MCP-3、`pydantic-ai-sandbox` の NR-1 が計画した
「annotations ↔ `requires_approval` 写像表」を本リポジトリの語彙に輸入）。既存の
`createToolApprovalPolicy`（`@vaz/agents/src/approval-policy.ts`）は「`needsApproval` が
`true`、または関数として `true` を返す」ことを承認要求のトリガにしているため、採用時は
MCP annotation → `needsApproval` の決定論写像をアダプタ層に固定する:

| MCP annotation | 値 | `needsApproval` 相当 | 理由 |
|---|---|---|---|
| `destructiveHint` | `true` | `true`（`'user-approval'` 強制） | 既存 `needsApproval: true` の email ツールと同じ扱い — 破壊的操作は常に人間承認 |
| `readOnlyHint` | `true` かつ `destructiveHint` 不在/`false` | `false`（自動承認） | `searchDocuments`/`getCurrentTime` と同等の非破壊ツール |
| `idempotentHint` | `false` | `destructiveHint` の値をそのまま維持（緩和しない） | 冪等でない = 再実行で追加の副作用があり得るため、`destructiveHint: false` だけを理由に自動承認へ倒さない |
| `openWorldHint` | `true` | 承認要否は変えないが、後述 §3 の sticky taint 対象に加える | オープンワールド（外部/未知のデータ源）とのやり取りは R5.3 の「信頼できない入力」前提に合致する |
| annotation 自体が未宣言 | — | `'user-approval'` をデフォルト（fail-closed） | `isApprovalCapable`（`approval-policy.ts`）が「`needsApproval` フィールドが無いツールは承認対象外」とする現行 in-process 規約と非対称 — MCP はサーバ側の申告を信頼しないため、未申告は安全側（承認要）に倒す |

この表は実装時にコードとして固定する（例: `mcpAnnotationsToApproval(annotations)` のような
純粋関数）。ホスト（`@vaz/agents`）の承認ポリシーが最終決定権を持ち、MCP サーバの自己申告
だけでは承認を免除しない（belt-and-suspenders — `createToolApprovalPolicy` の既存
`destructiveTools` allow-list と同じ設計思想）。

### 3. 供給網審査（Supply-chain vetting）

MCP サーバはコード実行主体を追加する外部依存であり、`pnpm-workspace.yaml` の
`allowBuilds`（install script 付き npm 依存を既定拒否・監査済みエントリのみ許可）と同じ思想を
適用する: 接続先 MCP サーバを事前に監査済みリストとして固定し、未審査サーバへの動的接続は
許可しない。stdio トランスポートはローカルの子プロセス起動を伴うため、`command`/`args` の
出自（誰が書いたバイナリか）は `allowBuilds` の監査観点と同一水準で扱う。

### 4. R5.2/R5.3 のツール結果への適用

MCP ツールの実行結果は `searchDocuments` の RAG 結果と同じ「信頼できない入力」として扱う:
`RETRIEVED_CONTEXT_BEGIN`/`UNTRUSTED_NOTICE`（R5.2、`packages/agents/src/prompt.ts`）の
デリミタ規約でラップし、`externallyDriven` sticky taint（R5.3、`approval-policy.ts`）を
MCP ツール結果の注入でも latch させる。特に `openWorldHint: true` のツールは、DB 越しの
`searchDocuments` と同様に「run 全体にわたって信頼境界を下げる」対象として扱う（上記写像表）。

## Evaluation Criteria For Future MCP Gateway Placement

MCP を採用する際、ゲートウェイ（複数 MCP サーバを集約するホスト側コンポーネント）を
どこに置くかの評価基準として、添付資料「Agentic AI アプリ開発における最先端技術トレンドと
アーキテクチャ設計」（以後 [HR] = Hybrid Report、本リポジトリには未コミット。
[`docs/pydantic-llamaindex-fastapi-enhancement.md`](../pydantic-llamaindex-fastapi-enhancement.md)
検討時に参照された添付文書）§5.1 の脅威モデルと §5.2 のポリシー例を評価軸として参照する
（Req 6.3）。[HR] 本文はリポジトリ内に存在しないため、本 ADR は要件定義（spec.md Req 6.3）が
固定した 4 脅威の名称を正本として、本リポジトリの語彙で以下のように解釈する:

- **Tool-list exposure** — 複数 MCP サーバを集約するゲートウェイは、単一エージェントの
  コンテキストに全サーバのツール一覧を晒す。MCP-2（ツールセット肥大）の裏側であり、
  トークンコストだけでなく「宣言されたツール一覧そのものが攻撃者にとっての列挙可能な
  攻撃面になる」リスクを含む。
- **Action-class ambiguity** — `destructiveHint` 等の annotation はサーバの自己申告であり、
  ホストが独立に検証する手段を持たない。悪意または実装ミスのあるサーバが実際の破壊的操作を
  `destructiveHint: false`（またはヒント自体を欠落）で申告すると、上記写像表の fail-closed
  デフォルト以外に防御手段がない。
- **stdio credential exposure** — stdio トランスポートはローカル子プロセスとして起動され、
  認証情報が典型的に env var/argv 経由で渡る。同一ホスト上でプロセス情報を参照できる主体に
  対して、in-process 関数呼び出し（クロージャでスコープされた secrets）より広い露出面を持つ。
- **stdio visibility gap** — HTTP/SSE トランスポートはプロキシ・ロギングで通信を横取りできるが、
  stdio は標準入出力のパイプであり、ホスト自身が明示的に計装しない限り、リクエスト/レスポンス
  ペイロードが既存の OTel span・audit-hook（単一発火点、`audit-hook.ts`）から見えない。

**§5.2 ポリシー例**についても [HR] の具体的な条文はリポジトリ内に無いため、本 ADR は
同節が要求する評価軸を「annotation（destructive/read-only）× world-exposure（open/closed）に
基づく段階的承認ポリシー」として本リポジトリの既存機構への適合性チェックに輸入する: 上記
写像表がこの軸をすでに満たしているか（`destructiveHint`×`openWorldHint` の組がすべて
`'user-approval'` に倒れるか）を、MCP ゲートウェイ設計時のレビュー項目とする。

## References

- [`docs/agentic-engineering-review.md`](../agentic-engineering-review.md) §1.7（MCP-1〜MCP-5）、
  §2.2（V-6）、§3（P3 / RV-6）
- [`docs/pydantic-llamaindex-fastapi-enhancement.md`](../pydantic-llamaindex-fastapi-enhancement.md)
  §1.2（sandbox NR-1）、§1.3、§4（PL-4）
- `specs/002-pydantic-enhance/spec.md` Req 6.2, 6.3
- [`packages/agents/src/approval-policy.ts`](../../packages/agents/src/approval-policy.ts)
  （`createToolApprovalPolicy`、既存 2 ゲート方式の正本）
- [`packages/tools/src/allowlist.ts`](../../packages/tools/src/allowlist.ts)（`RECIPIENT_ALLOWLIST`）
- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)（`allowBuilds`、供給網審査の既存前例）
- [`docs/agentops.md`](../agentops.md) — Req 6.1、本文書と対をなすガバナンス文書
