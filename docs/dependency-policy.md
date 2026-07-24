# Dependency Advisory Response Runbook

- **仕様根拠**: Req 1.3, 1.4, 1.5, 2.3, 2.4（`specs/003-dependency-security-hardening/spec.md`）
- **関連**: [`pnpm-workspace.yaml`](../pnpm-workspace.yaml)（`overrides`/`allowBuilds`/`minimumReleaseAge` の単一正本）、
  [`AGENTS.md`](../AGENTS.md) の Supply chain gate 項

散文は日本語、識別子・型・パス・コードは英語（`spec.json` `language: ja`）。

---

## 対象

`pnpm audit --audit-level=moderate` が新規 advisory で失敗したとき（CI の `audit` ジョブ、
pre-commit フック、`mise run check` のいずれか）にどう対応するかの定型手順。2026-07-22〜24 に
実際に発生した 19 advisory（`next`/`next-auth`/`sharp`/`js-yaml`/`brace-expansion`）の対応が
本手順の初回実例であり、`pnpm-workspace.yaml` の `overrides` コメントに実例が残っている。

## 1. 検知

CI の `tests` ワークフローが `audit` ジョブ（Task 3 で `unit` から分離済み — 分離前は `unit`
内の直列ステップ）で失敗する。または `.githooks/pre-commit` 経由でローカル `git commit` が
`mise run audit` で止まる。**コード変更が原因でない CI 赤**はまず advisory 起因を疑う。

## 2. 棚卸し

```sh
pnpm audit --audit-level=moderate --json > /tmp/audit.json
```

JSON 出力から各 advisory について次を確認する:

- 影響パッケージが**直接依存**（`apps/web/package.json` 等）か**推移的依存**か
- 修正版が存在するか（`vulnerable_versions` / `patched_versions`）
- 経路（`via` チェーン）— 本番依存経路か dev-only 経路か（対応の緊急度が変わる）

## 3. 対応 4 段階の選択基準

advisory ごとに、上から順に当てはまる最初の手段を選ぶ(番号が小さいほど優先)。

| # | 手段 | 適用条件 | 実装箇所 |
| --- | --- | --- | --- |
| 1 | **直接依存バンプ** | 影響パッケージが直接依存で、修正版が `package.json` の許容範囲内(またはメジャーバンプが許容できる) | `apps/web/package.json`(または該当 `packages/*/package.json`) |
| 2 | **範囲内 lockfile 更新** | 影響パッケージが直接依存の許容範囲内(`^`/`~`)にすでに修正版がある — バンプ不要で `pnpm install`/`pnpm update` のみで解決 | `pnpm-lock.yaml`(コマンド実行のみ、手動編集しない) |
| 3 | **override** | 影響パッケージが**推移的依存**で、上位パッケージ(例: `next`)の依存範囲が修正版を含まない | `pnpm-workspace.yaml` `overrides` |
| 4 | **ignoreGhsas** | 修正版が**存在しない**、または存在するが `minimumReleaseAge`(24h)未達で解決不能 — 一時的な監査除外 | `pnpm-workspace.yaml` `auditConfig.ignoreGhsas` |

4 段階すべてに共通する制約(NFR-2): **env・CI 変数での等価設定は行わない**。すべて
`pnpm-workspace.yaml`(または `package.json`)への committed change とし、理由をコメントで残す。

override を追加する際のコメント規約(既存の 4 件が実例):

```yaml
# <package>: <vulnerable-range> (via <upstream>) has <vuln-summary> (<GHSA-ID>);
# patched in <patched-version>. <撤去条件>.
```

## 4. 検証手順

対応後は必ず以下を通す(順不同ではなく、この順で実行する — audit だけ通しても壊れた
lockfile/依存解決を検出できないため):

```sh
pnpm install                              # lockfile 再解決を確認
mise run check                            # lint + typecheck + test:run + audit + lint:model-ids
NODE_ENV=production mise run build        # next build がクリーンに完走することを確認
```

`mise run check` が `audit` を含むため、`pnpm audit --audit-level=moderate` が exit 0 になった
時点で棚卸しした advisory がすべて解消されたことが確認できる。

## 5. `minimumReleaseAge` / `minimumReleaseAgeExclude` との関係

`pnpm-workspace.yaml` の `minimumReleaseAge: 1440`(24h)は、公開直後の悪意あるパッケージが
検知・撤回される前の危険な窓を避けるための既定ポリシーであり、advisory 対応でも**維持する**。

- 通常の advisory 対応(上記 4 段階)では、選んだ修正版が 24h 超経過していれば
  `minimumReleaseAge` に抵触せず解決できる。
- **抵触するケース**(公開直後の緊急パッチを今すぐ取り込む必要がある場合)は
  `minimumReleaseAgeExclude` に対象パッケージを個別・期限付きで追加する。
  期限を過ぎたら `minimumReleaseAgeExclude` のエントリを削除する(既定ポリシーへ復帰)。
- `minimumReleaseAge` そのものを下げる/無効化することは行わない(NFR-2 の「等価な緩和策で
  ポリシーを迂回しない」原則に反する)。

## 6. override / ignoreGhsas の撤去条件表

各エントリは撤去条件を宣言し、条件が成立したら**追加コミットで撤去する**(放置しない)。

| エントリ | 種別 | 撤去条件 | 状態(2026-07-24) |
| --- | --- | --- | --- |
| `postcss@<8.5.10` | override | 先行 spec 由来(GHSA-qx2v-qp2m-jg93)。`next` が固定する `postcss` 8.4.31 の XSS。本 spec の対象外 — 維持のみ、新規判断は行わない | 維持中(next の `postcss` 依存範囲更新待ち) |
| `sharp@<0.35.0` | override | `next` stable の依存範囲(現 `^0.34.5`)が `>=0.35.0` を含む版へ更新された時点で撤去(next canary は既に `^0.35.3`。upstream 方向と整合) | 維持中(next stable の依存範囲更新待ち) |
| `js-yaml@>=4.0.0 <4.3.0` | override | `openapi-typescript` → `@redocly/openapi-core` の依存範囲が `js-yaml@^4.3.0` 以上へ更新された時点で自然解消 | 維持中(upstream 範囲更新待ち) |
| `brace-expansion@>=2.0.0 <2.1.2` | override | `@redocly/openapi-core` → `minimatch` の依存範囲が `brace-expansion@^2.1.2` 以上へ更新された時点で自然解消 | 維持中(upstream 範囲更新待ち) |

撤去手順: 対象パッケージの `pnpm why <package>` で依存範囲を確認 → override を削除 →
`pnpm install` → `mise run check` green を確認 → コミット。

### `ignoreGhsas` の書式例

`pnpm-workspace.yaml` は現状 `auditConfig.ignoreGhsas` を**空で導入していない**(修正版のない
advisory が今のところ存在しないため)。必要になった時点で以下の書式で追加する:

```yaml
auditConfig:
  ignoreGhsas:
    # GHSA-xxxx-xxxx-xxxx: <(a) advisory の内容を1行で>
    # 除外理由: <(b) 修正版が存在しない/minimumReleaseAge 未達 などの具体的理由>
    # 再評価期限: <(c) YYYY-MM-DD — この日までに再度 pnpm audit で解消可否を確認する>
    - GHSA-xxxx-xxxx-xxxx
```

**運用ルール(R2.4)**: `ignoreGhsas` のエントリは**一時的**なものであり、`pnpm-workspace.yaml`
に触れる PR ごとにレビューする(その PR の変更内容と無関係でも、diff に含まれていれば確認
対象とする)。再評価期限を超過したエントリは lint 違反と同等の技術的負債として扱い、
次にその PR で `pnpm-workspace.yaml` を触る際に解消(修正版の再確認・撤去、または期限延長の
明示的な再判断)を行う。期限延長は「延長した」ことが分かるよう日付を更新し、無言での
先延ばしは行わない。

## 7. 自動依存更新ボット(Renovate/Dependabot)の採否基準

現状(2026-07-24)、Renovate/Dependabot 等の自動依存更新ボットは**導入していない**
(導入自体は本 spec の対象外 — R1.5 は採否基準の記録のみ)。将来導入を検討する場合の整合条件:

- **`minimumReleaseAge` との整合**: ボットが生成する PR は `pnpm-workspace.yaml` の
  `minimumReleaseAge: 1440` より新しいバージョンを提案しないよう設定する(Renovate の
  `minimumReleaseAge` オプション、Dependabot は同等機能がないため導入する場合は Renovate を
  優先する材料になる)。ボットの提案が 24h 未満のバージョンを含む PR を自動生成する設定は
  本リポジトリのポリシーと矛盾するため許容しない。
- **`allowBuilds` との整合**: ボットが新規の install script 付き依存を追加する PR を生成した
  場合、`allowBuilds` に対応エントリ(既定 `false`)が追加されていないと `pnpm install` が
  失敗する。ボット運用時もこのゲートを迂回する設定(`--ignore-scripts` の既定化等)は行わない —
  ボット PR も人間の PR と同じ audited-decision フローに従う。
- **レビュー負荷**: 自動生成 PR が `pnpm-workspace.yaml`(overrides/allowBuilds)を触る場合、
  上記 §6 の撤去条件表・レビュー運用と重複しないよう、ボット導入時は「ボット PR も
  `pnpm-workspace.yaml` 変更時レビュー対象」の運用に一本化する。
- **採用判断のトリガー**: 本 spec の 19 advisory のような手動対応が高頻度化した場合(目安:
  月 1 件超のペースで advisory 対応が発生)、導入コストに対するリターンが見込めるため
  再評価する。現状は低頻度(002 稼働以降で本 spec が初回)のため見送る。
