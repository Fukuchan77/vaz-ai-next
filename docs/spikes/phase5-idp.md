# Phase 5 スパイク — IdP 連携方式確定（Auth.js vs 社内標準ハンドロール OIDC）

> **Status**: ✅ Decided — **Auth.js（`next-auth@5`, JWT session strategy）を採用**
> **Resolves**: Clarification Q5（`spec.md` L62）/ Task 18.1
> **Requirements**: R5.1
> **Date**: 2026-07-11

散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

---

## 1. 目的とスコープ

R5.1: 「VAZ platform は社内 IdP OIDC（Entra ID / Google Workspace）でユーザーを認証し、`deps`
経由でツール実行をユーザー権限にスコープする。IdP 連携方式（Auth.js か社内標準）は Phase 5 開始時に
決定する」（`spec.md` Q5 は当初 deferred）。

本スパイクは「Auth.js（`next-auth`）」と「社内標準（`openid-client`/`oauth4webapi` 等のプリミティブを
直接使うハンドロール OIDC Relying Party 実装）」の 2 択を、Next.js 16 App Router / 既存アーキ規約
（`resolveModel()` の env 切替パターン、ADR-3 の deps 注入、Phase 1 の `db: null` 前提）への適合度で
比較し確定する。確定結果は Task 18.2（`apps/web/src/lib/auth.ts`）の実装方針になる。

### 手法

`next-auth@5` の公式ドキュメント（Context7 `/nextauthjs/next-auth`）・npm registry の
`peerDependencies` 実測・既存コードの `resolveModel()`/`model-allowlist.ts` パターンを根拠に、
実装レベルのコードスケッチで比較する（Phase 3 スパイクと同じ「ドキュメント + ソース根拠」の手法。
実 IdP テナント（Entra ID/Google Workspace）は用意されていないため、実 OAuth ラウンドトリップの
PoC は本スパイクの範囲外——構造比較に留める）。

---

## 2. 判定軸

| 軸 | 要求 |
| --- | --- |
| A. 複数 IdP 切替の容易さ | Entra ID ⇄ Google Workspace を実装追加なしに切替可能か（`AI_PROVIDER` 相当） |
| B. App Router / Edge 適合 | Server Component・Route Handler・Middleware での session 取得が Next.js 16 前提と整合するか |
| C. セキュリティプリミティブの所有 | PKCE・state/nonce・JWKS 検証・トークン検証を自前実装するか、検証済み実装に委ねるか |
| D. Phase 1 `db: null` との整合 | セッション永続化に DB adapter が必須か（`AgentDeps<DB = unknown>` は Phase 1 stateless） |
| E. `runtimeContext.role` への写像 | セッション→`{ userId, role }`（Task 18.2）へのカスタムクレーム注入が自然か |
| F. 運用フットプリント | 依存数・バージョン安定性・保守負荷 |

---

## 3. 軸 A — 複数 IdP 切替（Entra ID ⇄ Google Workspace）

- **Auth.js**: `providers: [MicrosoftEntraID({...}), Google({...})]` と配列に並べるだけで両方を
  同時に有効化でき、`signIn`/`account.provider` で分岐可能。単一 IdP 運用にしたい場合も
  `providers` 配列を env で組み立てれば `resolveModel()` と同型の「env だけで切替・再起動不要」を
  再現できる（`AUTH_IDP=entra-id|google-workspace` → 対応する provider のみ登録）。
- **社内標準**: Entra ID・Google Workspace それぞれの discovery document 取得・authorization
  code + PKCE フロー・token 検証を **IdP ごとに個別実装**する必要がある。両対応するには実装が
  2 系統に分岐する。

**軸 A 判定**: **Auth.js 優位**。80+ の公式 provider カタログ（`next-auth/providers/microsoft-entra-id`,
`next-auth/providers/google`）が profile 正規化まで含めて既製で、`resolveModel()` の
「env だけで provider 切替」という既存規約に最短で一致する。

---

## 4. 軸 B — App Router / Edge 適合

Auth.js v5 は App Router 専用に再設計されている（Context7 evidence, §9）:

```typescript
// apps/web/src/lib/auth.ts（Task 18.2 で実装予定の骨格）
import NextAuth from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import Google from "next-auth/providers/google";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [MicrosoftEntraID({ clientId, clientSecret, issuer }), Google({ ... })],
  session: { strategy: "jwt" },
});
```

- **Server Component**: `const session = await auth()` で直接取得（`getServerSession` 相当を
  App Router ネイティブに提供）。
- **Middleware**: `export default auth((req) => { /* req.auth */ })` で edge runtime 上でも
  session 検証可能（内部は `jose` ベースの JWT 検証で edge-compatible、DB I/O 不要）。
- **Route Handler**: `handlers`（`GET`/`POST`）を `app/api/auth/[...nextauth]/route.ts` に
  re-export するだけで OAuth の redirect/callback エンドポイントが揃う。

社内標準実装では、上記いずれも自前で書く必要がある（PKCE state を edge runtime 対応の cookie に
保持する処理、JWKS を edge runtime でキャッシュしつつ検証する処理、など）。

**軸 B 判定**: **Auth.js 優位**。App Router 三形態（Server Component/Middleware/Route Handler）に
対する統合が公式に提供され、VAZ の既存 `route.ts` 薄アダプタ方針（AGENTS.md）とも整合する。

---

## 5. 軸 C — セキュリティプリミティブの所有

OIDC の authorization code + PKCE フローは、state/nonce 検証・JWKS ローテーション追従・
`id_token` 署名検証・`aud`/`iss`/`exp` クレーム検証など、**実装ミスが即座に認証バイパスや
トークン置換攻撃に直結する**領域。

- **Auth.js**: `@auth/core` が内部で `oauth4webapi`（同一メンテナ `panva` による OAuth/OIDC の
  低レベル実装、`openid-client` と共通の設計血統）を用い、上記チェックを実装ずみで提供。
  VAZ 側が書くのは provider 設定値のみ。
- **社内標準**: `openid-client`（Context7 `/panva/openid-client`）等のプリミティブを使っても、
  discovery→PKCE→callback→検証の**配線自体**は自前実装になり、コードレビューでこの配線の
  正しさを継続的に保証する負荷が発生する。

**軸 C 判定**: **Auth.js 優位（決定的）**。認証はアプリケーションの信頼境界そのものであり、
「car wheel の再発明を避ける」（ADR-2 と同じ原則）を最も強く適用すべき領域。実装済み・
広く運用実績のあるライブラリに委ねる方が、内製実装より安全側に振れる。

---

## 6. 軸 D — Phase 1 `db: null` との整合

`packages/schemas/src/deps.ts` の `AgentDeps<DB = unknown>` は Phase 1 で `db: null`
（stateless）。Phase 2 で pgvector 用に Postgres が導入されているが、**認証セッションの永続化に
その DB を流用する必然はない**（`AgentDeps.db` はエージェント/ツールの関心であり、
`apps/web` の HTTP セッション管理とは責務が異なる — AGENTS.md の「apps/web は薄い HTTP
アダプタ」原則）。

- **Auth.js — `session: { strategy: "jwt" }`**: セッションは署名付き JWT を httpOnly cookie に
  格納し、**DB adapter 不要**。ステートレスに検証でき、Phase 1〜5 を通じて追加の永続化層を
  導入しない。
- **社内標準**: セッション文字列の署名検証を自前実装するか、DB backed session（Drizzle
  テーブル追加）に頼るか、いずれかを選択する必要が生じる。

**軸 D 判定**: **Auth.js（JWT strategy）優位**。追加インフラ・スキーマなしで既存の
stateless 前提と整合する。

---

## 7. 軸 E — `runtimeContext.role` への写像（Task 18.2 への申し送り）

Task 18.2 は「セッション権限を `runtimeContext`（`{ userId, role }`）へマップ」する。Auth.js は
`jwt`/`session` callback でカスタムクレームを注入できる（§9 evidence）:

```typescript
callbacks: {
  jwt({ token, account, profile }) {
    if (account) token.role = resolveVazRole(profile); // 下記参照
    return token;
  },
  session({ session, token }) {
    session.user.role = token.role;
    return session;
  },
},
```

**`role` の出典に関する追加決定**: Entra ID は App Roles（アプリ登録側で定義し `roles` クレームで
id_token に載る）を持つが、Google Workspace の OIDC id_token は同等の「アプリ固有ロール」クレームを
標準では持たない（Admin SDK Directory API 呼び出しが別途必要）。IdP ごとにロース粒度が非対称なため、
**VAZ 側の role は IdP クレームを直接信用せず、`@vaz/config` に置く社内 allowlist
（`model-allowlist.ts` と同じ「単一の正当な配置場所」パターン）でメールアドレス/ドメイン→VAZ role を
マップする**方針とする（具体テーブル定義は Task 18.2 の実装スコープ）。Auth.js の
`resolveVazRole(profile)` はこの allowlist を呼ぶだけの薄い関数になる。

**軸 E 判定**: **Auth.js 優位**。`jwt`/`session` callback という単一の差し込み点があり、
IdP 非対称性を吸収する社内 allowlist 呼び出しをそこに閉じ込められる。

---

## 8. 軸 F — 運用フットプリント

| | Auth.js（`next-auth@5`） | 社内標準 |
| --- | --- | --- |
| 依存 | `next-auth`（1 パッケージ、`@auth/core` を内包）。DB adapter 不要（JWT strategy）。 | `openid-client`（もしくは `oauth4webapi`）+ 自前の cookie/CSRF/middleware コード |
| バージョン安定性 | v5 は **beta**（`5.0.0-beta.31`、npm 実測）。`peerDependencies.next` は `^14.0.0-0 \|\| ^15.0.0 \|\| ^16.0.0` — **本リポジトリの Next.js `^16.2.10` と互換**。API は概ね安定だが破壊的変更の可能性は残る。 | 破壊的変更リスクはゼロだが、その分の設計判断を全て自前で引き受ける。 |
| ライセンス | ISC（OSS、商用利用制限なし） | — |
| 保守負荷 | provider 定義・callback のみ保守。セキュリティ修正は upstream 追従。 | 認証コードパス全体を自前でセキュリティレビュー・保守し続ける。 |

**軸 F 判定**: **Auth.js 優位**。v5 beta である点はリスクだが、`next: ^16.0.0` 対応を明示しており
（peerDependencies 実測）、VAZ の Next.js 16 と噛み合う。認証コードの保守負荷を自前で持つコストの方が
長期的に高い。

---

## 9. 決定 — Auth.js（`next-auth@5`, JWT session strategy）

### 結論

Phase 5 の IdP 連携方式は **Auth.js（`next-auth@5`）を JWT session strategy で採用**する。
`apps/web/src/lib/auth.ts`（Task 18.2）に `MicrosoftEntraID`/`Google` provider を
`AUTH_IDP` 相当の env 切替（`resolveModel()` と同型パターン）で登録し、`jwt`/`session` callback で
`@vaz/config` の社内 role allowlist を通してセッションを `runtimeContext: { userId, role }` へ写像する。

### 根拠（優先順）

1. **セキュリティプリミティブを自前実装しない（軸 C, 決定的）** — OIDC の PKCE/state/nonce/JWKS/
   トークン検証はアプリの信頼境界そのもの。実績あるライブラリに委ねる方が安全側。
2. **App Router 三形態への公式統合（軸 B）** — Server Component `auth()`・edge middleware・
   Route Handler `handlers` が VAZ の薄いアダプタ方針（AGENTS.md）と直接整合。
3. **複数 IdP 切替が既存の env 切替パターンと同型（軸 A）** — `resolveModel()`/`AI_PROVIDER` の
   設計原則をそのまま踏襲できる。
4. **Phase 1 の `db: null` 前提を維持（軸 D）** — JWT strategy は DB adapter 不要。追加スキーマ・
   追加インフラを持ち込まない。
5. **`runtimeContext.role` への写像点が単一（軸 E）** — `jwt`/`session` callback に
   社内 role allowlist 呼び出しを閉じ込められる。

### 却下理由（社内標準ハンドロール OIDC）

制御と依存最小化は得られるが、(a) PKCE/state/nonce/JWKS 検証という**セキュリティクリティカルな
配線を自前で保守し続ける負荷**、(b) Entra ID / Google Workspace 両対応時の実装が 2 系統に分岐する
こと、(c) App Router 三形態（Server Component/Middleware/Route Handler）への統合を都度自前実装する
コストが、VAZ の要件規模（内部業務ツール、IdP 2 種）に対して不釣り合い。**強い理由がない限り採らない**
（Inngest スパイクの § 7 と同じ「過剰設計の回避」原則）。

### 受入基準 → 採用プリミティブ 対応表

| AC | Auth.js プリミティブ |
| --- | --- |
| R5.1（IdP OIDC 認証） | `providers: [MicrosoftEntraID(...), Google(...)]`、env で有効化する provider を選択 |
| R5.1（Entra ID / Google Workspace 両対応） | provider 配列 + `signIn` callback でドメイン/テナント制約（Google Workspace の `hd`/email domain 検証） |
| R5.1（`runtimeContext` へのユーザー権限スコープ） | `jwt`/`session` callback で `@vaz/config` role allowlist を経由し `{ userId, role }` を注入 |
| Phase 1 `db: null` との整合 | `session: { strategy: "jwt" }`（DB adapter 不要） |
| App Router 統合 | `auth()`（Server Component/Middleware）、`handlers`（Route Handler） |

---

## 10. リスクと軽減 / 撤退基準

- **リスク: `next-auth@5` が beta（破壊的変更の可能性）** → 軽減: `pnpm-workspace.yaml` の
  `package.json` で exact/範囲を狭く固定し、stable リリース後に控えて追従。`peerDependencies`
  実測（`next: ^14.0.0-0 || ^15.0.0 || ^16.0.0`）で本リポジトリとの互換は現時点で確認済み。
- **リスク: Google Workspace が Entra ID 同等のアプリロースクレームを持たない（非対称性）** →
  軽減: role 判定を IdP クレームに依存させず `@vaz/config` の社内 allowlist に一元化（§7）。
- **リスク: JWT session strategy はトークン即時失効（revocation）が難しい** → 軽減: 内部業務ツール
  規模では許容範囲と判断（有効期限を短く設定 + `session.maxAge` で運用）。要件が変わり即時失効が
  必須になった場合はデータベースセッション（Drizzle adapter、Phase 2 の Postgres を再利用）へ
  切替可能（Auth.js は adapter 差し替えのみで済む — エンジンロックインなし）。
- **撤退基準（社内標準への再評価トリガ）**: (a) `next-auth` が Next.js 16 系のサポートを打ち切る、
  (b) 監査/コンプライアンス要件が「認証コード全体の自社完全所有」を義務化する、(c) beta の破壊的
  変更が実装を頻繁に破壊する — いずれかが現実になった時点で再評価。

---

## 11. 次アクション（Task 18.2 への申し送り）

- **18.2**: `apps/web/src/lib/auth.ts` に `NextAuth({ providers: [...], session: { strategy: "jwt" },
  callbacks: { jwt, session } })` を実装。`AUTH_IDP`（`entra-id` | `google-workspace`）を
  `@vaz/schemas/env`（leaf、既存 `aiEnvSchema` と同型）に追加し、provider 配列を env で組み立てる。
  `jwt` callback から `@vaz/config` の role allowlist（新規、`model-allowlist.ts` と同じ配置原則）を
  呼び、`runtimeContext: { userId, role }` を tool 実行の deps スコープへ流す配線は
  Task 20（audit）・既存 `runtimeContext`（`telemetry.ts` の `{jobId, userId, agentName}`）との
  整合を取る。

---

## 12. 根拠（Evidence）

- Auth.js Microsoft Entra ID provider 設定（`clientId`/`clientSecret`/`issuer`、`handlers`/`auth`/
  `signIn`/`signOut` export）: Context7 `/nextauthjs/next-auth`
  `docs/pages/getting-started/providers/microsoft-entra-id.mdx`。
- Auth.js JWT session + `jwt`/`session` callback によるカスタムクレーム注入
  （`token.accessToken`/`session.user.id` パターン）: Context7 `/nextauthjs/next-auth`
  `apps/examples/nextjs/auth.ts`、`docs/pages/guides/extending-the-session.mdx`。
- Auth.js Google provider の `email_verified`/ドメイン制約 `signIn` callback パターン
  （Google Workspace 相当の `hd`/ドメイン検証に転用可能）: Context7 `/nextauthjs/next-auth`
  `docs/pages/getting-started/providers/google.mdx`、`docs/pages/guides/restricting-user-access.mdx`。
- Auth.js middleware 統合（`export default auth((req) => {...})`）・Server Component
  `await auth()`: Context7 `/nextauthjs/next-auth` `packages/next-auth/src/index.ts`、
  `apps/examples/nextjs/app/server-example/page.tsx`。
- `next-auth@5` peerDependencies 実測（`next: ^14.0.0-0 || ^15.0.0 || ^16.0.0`,
  `react: ^18.2.0 || ^19.0.0`）: `npm view next-auth@beta peerDependencies`
  （latest beta tag `5.0.0-beta.31`）。
- `openid-client`（`/panva/openid-client`, 同メンテナ `panva` による低レベル OAuth/OIDC 実装）を
  社内標準実装の想定基盤として比較対象に採用: Context7 resolve-library-id 結果。
- VAZ 側根拠: `packages/config/src/model-allowlist.ts`（社内 allowlist の配置パターン, ADR-5）;
  `packages/config/src/telemetry.ts`（既存 `runtimeContext: {jobId, userId, agentName}` 形状）;
  `packages/schemas/src/deps.ts`（`AgentDeps<DB = unknown>`, Phase 1 `db: null`）;
  `spec.md` Q5（IdP 連携方式 deferred）; `plan.md` §Phase 5（`docs/spikes/phase5-idp.md` / R5.1）。
