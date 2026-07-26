# Act Phase — 003-dependency-security-hardening

PDCA Act: 実装の学びを再利用可能なパターン/予防策へ形式知化する。
散文は日本語、識別子・パス・コードは英語(`spec.json` `language: ja`)。

## Check Phase Summary

スコープ内の全 AC(全 21 AC 中 17 が実装・検証完了、残 4(2.2/5.1/5.2/5.3)は運用者アクション/別 spec 所管として明示的に申し送り)が着地。品質ゲート(`check` 572 / `py:check` 61 / `NODE_ENV=production` build)はすべて green、PR #4 で集約 `gate` ジョブの初回実走も確認済み。実装欠陥はゼロで、残件は本 spec の欠陥ではなく環境制約(`ANTHROPIC_API_KEY` 未設定)・リポジトリ設定(branch protection 未作成)・002 由来のテスト資産の脆さに分類される。

## Outcome

**Success**(スコープ内は全着地。残件はすべて spec 外要因として区別記録)

## Success Pattern OR Mistake Record

### Pattern — 監査済みコミット決定ゲート(撤去条件つき)

- **Problem**: サプライチェーン/ポリシー系のゲート(`pnpm audit`)は、コード無変更でも上流 advisory 公開だけで CI・pre-commit を赤くする。都度アドホックに `env`/CI 変数で抑止すると、抑止の事実・理由・撤去条件が追跡不能な暗黙知になり、回復可能性と監査性を同時に失う。
- **Solution**: 例外・一時許容・強制解決のすべてを **`pnpm-workspace.yaml` にコメント付きでコミットされた「監査済み決定」** として一元化する(`overrides` / `auditConfig.ignoreGhsas` / `allowBuilds` が同一パターン)。各エントリは (a) 対象 GHSA/内容、(b) 理由、(c) 撤去/再評価条件を必ず併記。`env` や CI シークレットでの等価抑止は導入しない(NFR-2)。撤去条件の運用は単一正本(`pnpm-workspace.yaml`)+ 参照 runbook(`docs/dependency-policy.md`)の 2 層で管理し、撤去時は両方を更新する。
- **Implementation**: (1) audit を `unit` から独立ジョブへ分離し失敗時も可視性を保つ、(2) `unit`/`audit`/`e2e` を集約する `gate` ジョブ(`needs:[...]`, `if: always()`, 明示的 result 文字列比較)を単一 required-check にする、(3) runbook に「直接バンプ → 範囲内 lockfile 更新 → override → ignoreGhsas」の 4 段階選択基準と撤去条件表を置く。
- **Benefits**: 上流起因の失敗を定型手順で解消でき、抑止の全件がレビュー対象のコード差分として残る。期限超過エントリを lint 相当の技術負債として扱える。将来 license-check 等の別ゲートにも同型展開可能。
- **Evidence**: `pnpm-workspace.yaml:16-29`(GHSA コメント付き 3 override)、`docs/dependency-policy.md`(138 行)、`.github/workflows/tests.yml:88-92`(`gate` ジョブ)、PR #4 の `gate` green 実走。
- Saved to: `.sdd/patterns/audited-committed-decision-gate.md`

## Learnings → Rules Mapping

| Learning | Candidate rule / steering update |
|----------|----------------------------------|
| サードパーティの**振る舞い前提**は型の存在確認だけでは不十分(Task 5.2: `RunUsage.total_tokens` のセマンティクスを pin 版ソース直読で反証) | gap-analysis / plan 段階で「型の存在」と「振る舞いの契約」を分離して検証する。plan が第三者ライブラリの挙動を前提にテストを指示する場合、実装前に pin 版ソースを直読する gate を tdd-enforcement に追加 |
| タスク Boundary の厳守が隣接する同種欠陥を見落とす(Task 5.1 の `routes/eval.py` 限定が同型の `resolve_judge_llm` bare assert を残した) | 各タスク完了時に「同じ理由で他所に存在するはずのパターン」を横断 grep する self-review ステップを常設化(R6 として後追い追認できた) |
| CI チェックの required-check 化は「初回実走 → 設定作成」の順序が安全 | branch protection / required status check の新規作成は、対象チェックが CI 上で最低 1 回 green になった後に行うことをデフォルト手順化 |
| 単一の環境制約(`ANTHROPIC_API_KEY` 未設定)が複数の運用確認(5.1/5.3)を同時ブロック | 運用確認タスクは着手前に前提となる secret/インフラの有無を洗い出し、共通の外部依存は個別追跡せず単一フォローアップに集約 |
| 過去 FLAG(「サンドボックスで pgvector pull 不可」)は環境が変われば陳腐化する | 引き継いだ FLAG/前提は現在の環境で再確認してから作業計画に織り込む(本セッションで実 DB migration を初実証) |

## Process Improvements

- 「テスト対象コードが存在しない」タスク(文書新設・コメント追記)は RED を空とし、既存集約ゲート(`mise run check`)を検証手段とする方針を明示的に採る(無理に unit test を作らない)。
- CI YAML など「振る舞いではなく構造」を持つ成果物は、使い捨ての構造検証スクリプト(PyYAML `safe_load` + アサーション)で RED→GREEN を保ちつつ永続テストファイルを増やさない。
- `/sdd-ship` 起票時に未計画の防御的差分を見つけたら、コミット前に spec/tasks へ後追い追記(本 spec の R6/Task 8)してトレーサビリティを保つ — 次回 Check の「未計画コミット」誤検出を防ぐ。

## Next Actions

- **[運用者]** PR #4 マージ後、`gh api .../branches/main/protection -X PUT` で `gate` を単一 required check として branch protection を新規作成(手順は PR 本文/`pdca/do.md` Task 3)。
- **[運用者/002]** リポジトリ Secrets に `ANTHROPIC_API_KEY` を追加 → 次回 PR で `eval-pr.yml` の閾値ブロック判定への遷移(002 Req 5.4 初回観測)、及び nightly の tier1/tier3 verdict を実観測(003 R5.1/5.3 の申し送り解消)。
- **[002]** M3 locator E2E の 2 原因(`getByText` 曖昧一致バグ / 合成 PDF の OCR 末尾文字欠落)を 002 側の追跡課題として修正。002 `pdca/act-final.md` の PENDING を「実施済み・fail・原因当たり記録」へ更新。
- **[maintainer]** next stable が `sharp` 0.35 系を取り込んだ時点で `sharp@<0.35.0` override を撤去(R1.4、runbook 撤去条件表 + `pnpm-workspace.yaml` コメントの両方を更新)。
