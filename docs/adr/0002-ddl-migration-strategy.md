# ADR-0002: DDL / migration 戦略(drizzle-kit 非採用の継続)

- **Status**: Accepted
- **Date**: 2026-07-25
- **仕様根拠**: Req 2.1〜2.6, NFR-4(`specs/005-baseline-recovery-refactor/spec.md`)、
  台帳 A-9(`specs/005-baseline-recovery-refactor/spec.md` Out of Scope / Future Work)

散文は日本語、識別子・型・パス・コードは英語(`spec.json` `language: ja`)。

---

## Context

再検証(2026-07-25、`18edd7ab`)で、`packages/db/drizzle/` の中身が
`0000_add_locator.sql`(`chunk` への `ALTER TABLE ADD COLUMN` 1 本)のみであることが判明した。
`CREATE EXTENSION vector` / 2 enum(`job_status`/`job_event_type`)/ 6 テーブル
(`document`/`chunk`/`embedding`/`job`/`job_event`/`audit_log`)の baseline DDL はリポジトリの
どこにも存在せず、`packages/db/src/schema.ts` と `docker-compose.yml` は「migration がそれを
所有する」と述べていた(2 箇所とも虚偽記述、R2.4 で是正済み)。fresh clone から DB を
provisioning する手段がゼロであり、004 act.md 申し送り 1(locator E2E 実スタック実走)は
構造的に実行不能だった。台帳 A-9「drizzle-kit 採用」のトリガー「次の DDL 変更」がこの baseline
不在という形で成立した。

## Decision

**drizzle-kit は本 spec でも採用しない。** 代わりに次の 3 点セットで baseline を回復する:

1. **手書き baseline DDL**(`packages/db/drizzle/0000_baseline.sql`)を `schema.ts` から導出して
   コミットする(NFR-4: `schema.ts` が正本 — SQL を先に書いて schema を合わせるのではない)。
   既存の `0000_add_locator.sql` は `0001_add_locator.sql` へ rename し、baseline が先に適用される
   ことを辞書順で自明にする(同一プレフィックスのまま baseline を差し込むと辞書順が逆転するため
   不採用 — plan.md Decisions)。
2. **DDL↔`schema.ts` ドリフト検出テスト**(`packages/db/tests/schema-ddl.spec.ts`)を、DB 接続なしで
   `drizzle/*.sql` を解析し `drizzle-orm` の `getTableColumns`/`getTableConfig` の出力と突合する形で
   追加する。これが drizzle-kit を採らない代償(生成による整合保証の欠如)の埋め合わせ装置である。
3. **`mise run db:migrate`**(`packages/db/bin/migrate.ts`)で `drizzle/*.sql` を辞書順・
   1 ファイル 1 トランザクションで適用する。`_vaz_migration` テーブルが適用済みファイル名を記録する。

**根拠**(003 pdca/do.md のスタンスを継続):

- baseline の起票自体は drizzle-kit を採らずに解決できる。drizzle-kit を採用すると「`schema.ts` を
  正本として SQL を手書きする」という既存の運用を、生成ベースの運用へ同時に入れ替えることになり、
  本 spec の refactor-only 性(挙動変更ゼロを diff で示せる範囲)を超える。
- drizzle-kit が保証する「生成物と定義の整合」は、手書き baseline + ドリフトテストで機械的に
  代替できる(次節「機械保証の射程」)。この代替装置が無いなら、drizzle-kit 採用のほうが正しい
  判断になる ── 本 ADR はその条件を明示することで、将来「装置を書く余力がない」状況になったときに
  drizzle-kit へ切り替える判断を後回しにしないようにする。

## Consequences

### (a) ドリフトテストの機械保証の射程

`packages/db/tests/schema-ddl.spec.ts` が機械的に保証するのは次の範囲である:

- table 集合・enum 名・enum 値の順序付きリスト
- 各列の**名前・SQL 型・NOT NULL・DEFAULT の有無**
- FK の**参照先テーブル/列と ON DELETE 挙動**(`cascade`/`set null` など)

**射程外**(人手レビューに委ねる):

- **index の存在は名前のみを突合する**。index の method(`hnsw` 等)や op class
  (`vector_cosine_ops` 等)の意味的な整合は本テストの対象外 ── これは
  `packages/db/tests/schema.spec.ts` の既存「DDL drift guard」ブロックが `schema.ts` 側だけを
  pin していることの裏返しであり、SQL 側の method/op class は人手レビューで確認する。
- **CHECK 制約の存在は名前のみを突合する**。式の意味的な等価性(例:
  `embedding_dim_fixed` の `= 768` という具体的な比較式)は本テストの対象外。
  `EMBEDDING_DIM` と `vector(N)` の次元・CHECK の比較値については、この 3 点が同じ数値
  `768` を指していることだけを個別に assert しており、これは名前の突合とは別の狙い撃ちの検証である。

この線引きが曖昧なまま「ドリフトテストがある」と主張することは、drizzle-kit 非採用の正当化を
無効にする。射程外の項目に変更が入る PR は、レビュアーがこの ADR を参照して手動確認すること。

### (b) `db:migrate` の冪等性スコープ

`db:migrate` の再実行は**無条件に冪等ではない**。冪等性が成立するのは次のいずれかの場合に限る:

- **fresh DB**(何のテーブルも存在しない状態)への初回適用、または
- **`_vaz_migration` 追跡下にある DB** への再実行(適用済みファイルはスキップされる)。

手動 `psql` で作られ `_vaz_migration` テーブルを持たない既存 DB に対しては、初回適用が
「テーブルが既に存在する」エラー(`42P07`)を検出して **fail-loud** で案内する
(`packages/db/bin/migrate.ts` の `describeUntrackedExistingDatabase`)。黙ってスキップすると、
その DB が baseline と実際に一致しているかどうかを誰も検証しないままドリフトを隠すことになるため、
意図的にエラーとしている。既存 DB を `db:migrate` の管理下に置くには、`_vaz_migration` へ
適用済みファイル名を手動で INSERT するか、DB を作り直して fresh 状態から適用する。

## 再トリガー条件

次のいずれかが成立した時点で、本 ADR を再評価し drizzle-kit 採用を具体化する:

1. **テーブル追加/変更を伴う機能 spec が来た時**。手書き baseline への追記が積み重なり、
   ドリフトテストの拡張コスト(新しい列種別・制約種別ごとにパーサを拡張する必要)が
   drizzle-kit 導入コストを上回ったとき。
2. **複数環境へバージョン管理された migration を適用する要件が生じた時**(例: staging/production
   を持つ複数 DB へのロールアウト順序管理)。現状は単一の dev DB のみを対象としており、
   `_vaz_migration` の単純な適用済み記録で足りている。

## References

- [`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)(正本)
- [`packages/db/drizzle/0000_baseline.sql`](../../packages/db/drizzle/0000_baseline.sql)、
  [`0001_add_locator.sql`](../../packages/db/drizzle/0001_add_locator.sql)
- [`packages/db/tests/schema-ddl.spec.ts`](../../packages/db/tests/schema-ddl.spec.ts)(ドリフト検出テスト)
- [`packages/db/bin/migrate.ts`](../../packages/db/bin/migrate.ts)(`mise run db:migrate` の実体)
- `specs/005-baseline-recovery-refactor/spec.md` Req 2, 台帳 A-9
- [`docs/adr/0001-mcp-position.md`](./0001-mcp-position.md)(節構成の前例)
