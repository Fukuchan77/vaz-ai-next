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

変更がなくても新規 advisory は降ってくるため、日次の `security-daily` ワークフローが両スタックを
見ている: `audit` ジョブ(`pnpm audit`)と `py-audit` ジョブ(`mise run py:audit` = `pip-audit`)。
Python 側は `python.yml` が `services/agent/**` にパスフィルタされており、サイドカーを触る PR が
来ない限り `py:check` は発火しないため、`py-audit` がその唯一の常設検知網になる。
2026-09-09〜11 の `security-daily` 3 連続失敗(js-yaml GHSA-2883-xcg3-v3hh、head SHA は不変)が
この経路の実例で、原因は「override が pin した 4.3.1 自身に新しい advisory が出た」ことだった。

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
mise run test:e2e                         # Playwright 側を触った場合のみ(pre-push と同じゲート)
```

`mise run check` が `audit` を含むため、`pnpm audit --audit-level=moderate` が exit 0 になった
時点で棚卸しした advisory がすべて解消されたことが確認できる。

Python サイドカー(`services/agent`)を触った場合は、上記に加えて:

```sh
mise run py:check                         # uv sync + ruff + pyright + pytest + py:audit
```

`py:check` の最終段が `py:audit`(= `uv run --frozen pip-audit`)なので、これが exit 0 なら
Python 側 advisory も解消済み。`uv lock --upgrade` 後は `pyproject.toml` の floor 引き上げ要否も
判断する — 同ファイル冒頭のコメントどおり、**メジャー跨ぎ、または 0.x のマイナー跨ぎ**のときだけ
引き上げ、同一メジャー内のドリフトは floor を触らない。

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

## 6. override / ignoreGhsas / ignore-vuln の撤去条件表

各エントリは撤去条件を宣言し、条件が成立したら**追加コミットで撤去する**(放置しない)。
Python 側の `pip-audit --ignore-vuln`(`mise.toml` の `py:audit`)も同じ表で追跡する —
置き場所が違うだけで、「一時的な監査除外に再評価期限を付ける」という扱いは共通。

| エントリ | 種別 | 撤去条件 | 状態(2026-09-11 再検証) |
| --- | --- | --- | --- |
| `js-yaml@>=4.0.0 <4.3.2` → `^4.3.2` | override | `openapi-typescript` → `@redocly/openapi-core`(dev-only)の quadratic-CPU DoS 3件: merge-key(GHSA-52cp-r559-cp3m、patched 4.3.0)、`!!omap`(GHSA-5p4m-2wfm-xmqj / CVE-2026-59870、patched 4.3.1)、`maxTotalMergeKeys` が空 merge source に対して CPU を制限しない(GHSA-2883-xcg3-v3hh、patched 4.3.2)。射程は 2 度拡大しているが理由は同一で、**この override が pin した patch 版がそのまま実解決版になるため、次の advisory が旧射程の外側に落ちる**(`<4.3.0` は 4.3.0 を、`<4.3.1` は 4.3.1 を取りこぼした)。`openapi-typescript` が pin する `@redocly/openapi-core` の `js-yaml` 範囲が `>=4.3.2` へ上がった時点で自然解消(現行の @redocly リリース系列は既に `^5.2.2` を要求しており、openapi-typescript の追随待ち) | 維持中(2026-09-11 再検証: `pnpm why js-yaml` で `@redocly/openapi-core@1.34.18` の pin が `4.3.0` のままであることを確認。override を外せば 4.3.0 に戻るため撤去不可) |
| `PYSEC-2026-3740` (nltk) | pip-audit `--ignore-vuln` | `llama-index-core` → `nltk`(推移的)の pathsec sandbox bypass(GHSA-8mgp-746c-j5xp / CVE-2026-81726): `TransitionParser.train/parse`・`AveragedPerceptron.save/load`・`PerceptronTagger.save_to_json`・`save_maxent_params` が pathsec-aware helper ではなく組み込み `open()` を使うため、allowed root の外を読み書きできる。**修正版が存在しない**(上流が "Not yet patched" と明記、PyPI 最新 3.10.3 が該当版) = 対応 4 段階の #4。nltk の修正版が公開されたら `uv lock --upgrade-package nltk` で取り込み、このエントリを撤去する | 維持中(2026-09-11 追加。サイドカーは nltk / pathsec を一切 import せず、llama-index-core 側の nltk 利用も punkt tokenizer のみ。脆弱な 4 API は venv のどこからも参照なし。**再評価期限: 2026-12-11**) |
| `postcss@<8.5.18` | override | **撤去済み(2026-08-08)** — `next` 16.3.0 が `postcss` 8.5.23 を直接 pin し、宣言していた撤去条件(「next の pin が `>=8.5.18` に達したら」)が成立。override 無しで 8.5.23/8.5.25 に解決することを確認 | 撤去済み |
| `sharp@<0.35.0` | override | **撤去済み(2026-08-08)** — `next` 16.3.0 stable の依存範囲が `^0.35.3` になり撤去条件成立。override 無しで 0.35.3 に解決 | 撤去済み |
| `nanoid@<3.3.17` | override | **撤去済み(2026-08-08)** — GHSA-2v37-7h3g-55p8 対応で一時追加(lock の 3.3.16 が patch 前で、推移的依存をコマンドで更新する手段がなかったため)。上記 postcss バンプで subtree が再解決され 3.3.17 に到達、「将来の再解決で自然解消」という撤去条件どおり不要化 | 撤去済み(2026-08-08) |
| `brace-expansion@>=2.0.0 <2.1.2` → `^5.0.8` | override | **撤去済み(2026-08-08)** — `minimatch` の依存側が 2.1.4 に解決され、advisory(GHSA-mh99-v99m-4gvg)が報告されなくなった | 撤去済み |
| `nanoid@<3.3.18` → `^3.3.18` | override | **撤去済み(2026-08-22)** — 2026-08-16 に再追加(GHSA-2v37-7h3g-55p8 の `patched_versions` が `>=3.3.18` へ拡大し、lockfile が 3.3.17 に固定されていたため)。宣言していた撤去条件の後段「override を外した fresh resolve で `pnpm audit` が clean のまま」が成立。`postcss@8.5.23`/`8.5.25` の依存範囲は `^3.3.16` のままだが、fresh resolve は範囲内の最新である 3.3.18 を選ぶため override 無しで clean | 撤去済み(2026-08-22) |

撤去は「override を外す → `pnpm install` で再解決 → `pnpm audit --audit-level=moderate` が clean のままであることを確認」という手順で 1 件ずつ検証した(2026-08-08 / 2026-08-22 とも同手順)。

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

## 7. 自動依存更新ボット(Dependabot)の運用ルール

**導入済み**(X-15、`.github/dependabot.yml`)。npm ワークスペース(`/`)、Python サイドカー
(`/services/agent`、uv)、GitHub Actions pin(`/`)の 3 ecosystem を weekly で見る。
`security-daily.yml` は脆弱版を**検知**するだけで更新を提案しないため、その穴を埋めるのが
Dependabot の役割という位置づけ。

> 本節は 2026-07-24 時点では「未導入・将来の採否基準」として書かれていた。X-15 で導入済みと
> なったため、当時の 4 条件を**運用ルール**として書き換えてある。特に「Dependabot は
> `minimumReleaseAge` 同等機能がないため Renovate を優先する材料」という記述は、Dependabot 側に
> `cooldown` が入ったことで前提が消滅した。

- **`minimumReleaseAge` との整合**: ボットが生成する PR は `pnpm-workspace.yaml` の
  `minimumReleaseAge: 1440` より新しいバージョンを提案してはならない。`.github/dependabot.yml`
  の npm / uv ブロックに `cooldown.default-days: 1`(= 1440 分)を設定してこれを実装している。
  どちらか一方だけを緩めない — 24h を変更するなら両方を同じ PR で動かす。
  GitHub Actions ブロックには意図的に `cooldown` を置いていない(理由はファイル内コメント参照)。
- **`allowBuilds` との整合**: ボットが新規の install script 付き依存を追加する PR を生成した
  場合、`allowBuilds` に対応エントリ(既定 `false`)が追加されていないと `pnpm install` が
  失敗する。このゲートを迂回する設定(`--ignore-scripts` の既定化等)は行わない —
  ボット PR も人間の PR と同じ audited-decision フローに従う。
- **保留中メジャーとの整合**: AGENTS.md の「Deliberately held-back majors」
  (vitest / @vitest/coverage-v8 / @types/node)は `.github/dependabot.yml` の `ignore` に
  写してあり、`tests/repo/dependabot.spec.ts` が root `package.json` と併せて 3 者の一致を
  検証する。据え置き判断を追加・撤回するときは 3 つを同じ PR で更新する。
  なお `typescript` は 2026-09-12 に root を 7.x へ移したため据え置きではなくなったが、
  `packages/schemas` だけは `openapi-typescript`(TS の JS コンパイラ API 依存)のために
  6.0.3 を pin している。Dependabot の npm ブロックはワークスペース単位でしか `ignore` を
  書けず特定マニフェストだけを除外できないため、ボットが `packages/schemas` に 7.x を
  提案しうる。これは**既知の受容済みギャップ**で、`contract-drift.spec.ts` が import 時点で
  落ち、`dependabot.spec.ts` が pin 自体を検証するため沈黙して通ることはない。
  openapi-typescript が TS 7 に対応したら pin ごと撤去する。
- **レビュー負荷**: 自動生成 PR が `pnpm-workspace.yaml`(overrides/allowBuilds)を触る場合、
  §6 の撤去条件表・レビュー運用と重複しないよう、「ボット PR も `pnpm-workspace.yaml`
  変更時レビュー対象」の運用に一本化する。
- **一括統合という選択肢**: Dependabot のオープン PR 上限(npm は既定 5 件)に当たると、
  提案版が実際の最新より古いまま頭打ちになる。また同一ファイルを触る PR が複数同時に開くと
  2 件目以降がコンフリクトする(2026-09-08 の #13/#15 が実例、どちらも `eval-pr.yml`)。
  個別マージが渋滞したら、1 ブランチで `pnpm update -r` / `uv lock --upgrade` / Actions SHA
  更新をまとめ、main 反映後に Dependabot の自動クローズに任せる方が速く、かつ結果も新しい
  (2026-09-11 の実例)。
