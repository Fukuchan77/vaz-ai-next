# Act Phase — 002-pydantic-enhance（Phase B）

PDCA Act: 実装結果の学びを再利用可能なパターン／予防策へ形式化する。
`/sdd-reflect 002-pydantic-enhance PhaseB` により生成。

## Check Phase Summary

Phase B（Python 評価サイドカー / Req 2 + NFR-1〜5、Task 4→5）は当初 12/12（100%）カバーと自己照合したが、
`/adversarial-review` が Req 2.7 の後半（span 属性のリクエスト経路での実 emit）の未配線を検出し、
訂正後の実質カバレッジは 11/12（91.7%）。`traced_span`/`get_tracer`/`get_logger` は実装・単体テスト
済みだが `/eval/*` の 2 ルートから一度も呼ばれず、`EvalRequest` にも相関 ID の入力経路が無い——
Phase A の Req 1.5（契約追加のみで配線欠落を ✅ 誤判定）と**同型の欠陥**が、Phase A で導入した
予防策（「Check フェーズ自体に全 SHALL 要件の実装 grep を組み込む」）の網をすり抜けて再現した。
それ以外は堅牢: `/eval/*` 2 エンドポイントは実際に `include_router` で配線・judge 解決・
verdict/score/token 写像まで通っている。46 Python テスト green（ネットワークゼロ）、
ruff/pyright strict/pip-audit/forbid-model-ids 全緑、TS 側 465 tests は Phase B 全編で不変緑。

## Outcome

**Partial（Req 2.7b 未配線を `/adversarial-review` で検出・訂正——Phase A の予防策はすり抜けを許した）**

## Success Pattern OR Mistake Record

### Pattern — ポリグロット・サイドカーの隔離シーム（polyglot-sidecar-isolation-seam）

- **Problem**: 単一言語（TS）で受入ゲート（`mise run check`・coverage・lint・供給網・git hooks）を
  固めたモノレポに、別言語（Python）のサービスを追加すると、(a) 既存ゲートを劣化・不安定化させる、
  (b) 言語境界を跨ぐ暗黙 import で一方向依存グラフを壊す、(c) model-id ゲート等の横断ルールが
  新言語に穴を開ける、(d) 新ツールチェーンを CI 必須にして既存の緑を新言語環境に人質に取る、
  といった劣化が起きやすい。
- **Solution**: 新言語トラックを **既存トラックと配線を分けた「隔離シーム」** として足す。
  1. **HTTP 境界のみ、双方向 import ゼロ** — 新サービスは `@vaz/*` 依存グラフの外。TS→新サービスも
     新サービス→TS も import しない。`grep -rn "<service>" apps packages --include=*.ts` = 0 件で機械保証。
  2. **ゲートは二トラック、集約は非依存** — 新言語ゲート（`py:check` = uv sync+ruff+pyright+pytest）を
     追加するが、既存集約タスク（`check`）の `depends` には**入れない**。TS 側は新ツールチェーン無しで
     緑を維持できる（NFR-1）。
  3. **各サブタスクで既存集約ゲートを再実行し非干渉を実測** — 新言語のファイル追加ごとに
     `mise run check` を回し、既存テスト数が不変であることを裏取り。「影響しないはず」でなく
     「影響しないことを毎回測る」。
  4. **横断ゲートは carve-out 追加でなく走査範囲拡張** — model-id 等の横断 grep ゲートは、新言語を
     `--include` に足し、モデル ID を保持する単一正本（`config.py`）だけを carve-out。それ以外は
     実コード側を直す（docstring の例示すら carve-out で逃げない）。走査拡張時はベンダーディレクトリ
     （Python なら `.venv`）を必ず `--exclude-dir` へ同時追加。
  5. **未配線の設定・依存を先取りしない** — 将来要件（S2S JWT ミドルウェア等）用のフィールドや
     SDK を「あとで使うから」と先に足さない。設定は必ず配線とセット、無ければ README で運用方針を
     文書化するに留める。
- **Implementation（この repo での具体）**:
  - `services/agent/`（FastAPI+Pydantic AI+LlamaIndex, uv, pyright strict）を `@vaz/*` 外に新設。
  - `mise.toml` `[tasks."py:check"]`（`dir="services/agent"`, run 配列で uv sync→ruff→pyright→pytest）。
    `[tasks.check].depends` は不変。
  - `scripts/forbid-model-ids.sh` を `--include='*.py'` + `services` 走査 + `.venv`/`__pycache__` 等
    `--exclude-dir` + `services/agent/app/config.py` の 1 carve-out に拡張。
  - `config.py` の `JUDGE_MODEL_ALLOWLIST`（`model-allowlist.ts` の Python ミラー）+ `model_validator`
    で allowlist 外を fail-loud。judge model ID は `services/**` でここ 1 箇所のみ。
- **Benefits**: 既存の緑を新言語環境に人質に取らず、フェーズ独立着地（NFR-1）を維持。境界の
  一方向性が grep で機械保証され、横断ルールの穴を防ぐ。「毎回測る」規律で回帰を早期検出。
- **Evidence**: `mise run py:check` → 46 passed / ruff・pyright strict・pip-audit 全緑。
  `bash scripts/forbid-model-ids.sh` → `services/**` 走査込みで green。Phase B 全編で TS 側
  `mise run check` = 465 tests 不変緑。TS↔services/agent の相互 import 0 件（grep 実確認）。
- Saved to: `.sdd/patterns/polyglot-sidecar-isolation-seam.md`

### Mistake Record — Req 2.7b（observability 配線）が Check の grep 裏取りをすり抜けた

- **What happened**: Check（初版）は Req 2.7 を ✅ と判定し、根拠として `test_telemetry.py` 6/6 green
  のみを引いた。`/adversarial-review` がフレッシュコンテキストで `traced_span` を producer 側
  （`app/routes/eval.py`）へ grep したところ、呼び出しが一切無いことが判明——`telemetry.py` の
  ヘルパー群は実装・単体テスト済みだが、Task 5.4（ルート実装）が実際にはこれを呼び出す配線を
  追加していなかった。`EvalRequest` にも `case_id`/`job_id` の入力フィールドが無く、相関 ID を
  渡す経路自体が存在しない。
- **Root cause**: Phase A の反省（`.sdd/mistakes/002-pydantic-enhance-2026-07-19.md`）で「Check は
  producer 側の実装ファイルへ直接 grep で裏取りする」という予防策を導入したが、本サイクルの
  grep セット（エンドポイント存在・ステートレス性・import 方向・`py:check`・model-id・
  network-zero・privacy ログ）は「ヘルパーが存在し単体テストが通るか」までしか裏取りしておらず、
  「そのヘルパーがリクエスト経路の呼び出し元から実際に呼ばれるか」という一段深い確認を
  含めていなかった。予防策自体は正しかったが、適用範囲が producer の**存在**確認に留まり、
  producer の**呼び出され方**（caller-side grep）まで踏み込んでいなかった。
- **Impact**: `/sdd-reflect` の要約が Phase B を「12/12（100%）、Phase A 型の欠陥は不在」と
  過大評価した。実害は小さい（同一セッションで検出・訂正）が、失敗モードは「ヘルパー関数を
  定義し単体テストで green にしたことと、そのヘルパーを本番コードパスから呼び出したことは
  別の達成」という、Req 1.5 の失敗モードの一般化（"契約の存在" と "配線の存在" の混同）が、
  さらに一段——"配線の存在（呼べば動く関数がある）" と "配線の実行（実際に呼ばれる）" の
  混同という形で再発したことを示す。
- **Prevention**: Check フェーズの実装 grep 裏取りは、要件が「SHALL do/emit/record X」型の場合、
  (1) X を生成する関数/ヘルパーが存在するか、(2) そのヘルパーが単体テストで正しく動くか、
  **(3) そのヘルパーが実際のリクエスト/実行経路（ルートハンドラ・フック・CLI エントリ）から
  呼ばれているか**——の 3 点を必ず区別して確認する。(3) の確認は `grep -rn '<helper_name>'
  <production_source_dir>` を実行し、ヒットが「定義ファイルのみ」でないことを確認する形が
  最も機械的（本レビューで採用した手法）。単体テストの存在（2）は（3）の代替にならない——
  単体テストは「ヘルパー単体が正しい」ことしか示さず「呼ばれている」ことを示さない。
- Saved to: `.sdd/mistakes/002-pydantic-enhance-2026-07-20-req2.7.md`

## Learnings → Rules Mapping

| Learning | Candidate rule / steering update |
|---|---|
| 「SHALL emit/record X」型要件の grep 裏取りは (1) ヘルパー存在 (2) 単体テスト green (3) **本番コードパスからの呼び出し** の 3 点を区別する。(3) は `grep -rn '<helper>' <production_dir>` でヒットが定義のみでないことを確認する | `/sdd-reflect` の Check ステップ手順に明記候補。Phase A の予防策（producer への grep）を「ヘルパー呼び出し確認」まで具体化して更新 |
| 新言語トラックの受入ゲートは二トラック化し、既存集約（`check`）の依存に入れない（既存の緑を新ツールチェーンに人質化しない） | steering（tech）に「ポリグロット追加時はゲートを二トラック・集約非依存に」。`polyglot-sidecar-isolation-seam` 参照。AGENTS.md には既に `py:check` の非依存が明記済み |
| 横断 grep ゲート（model-id 等）は新言語追加時に「走査範囲拡張 + 単一正本のみ carve-out + ベンダーディレクトリ exclude」の 3 点セットで拡張する | `scripts/forbid-model-ids.sh` 冒頭コメントに手順化済み。新言語追加チェックリスト項目化の候補 |
| tasks.md が「実装／テスト」を別サブタスクへ分割しているか（`_Depends:_` に後続テストタスクがあるか）が、Red-Green を自タスク内で適用するか後続へ委ねるかを決める唯一のシグナル | test-strategy / tdd-enforcement skill に「分割タスクの Red-Green 判定は `_Depends:_` 連鎖で決める」を追記候補。後続テストタスクが無いユニットロジックは自タスクで RED を通す（4.3/4.4/5.2）、明示分割は委ねる（4.2→4.5, 5.4→5.5） |
| 分割タスクで「テスト後追加」する場合は本物の RED を経由しないため、実装コードを読んでから網羅パターンを逆算するレビュー discipline でカバレッジ十分性を担保する | test-strategy skill に「test-after 分割時は実装読解ベースの網羅レビューを必須に」 |
| `.editorconfig` の repo-wide 設定（tab）は元言語前提。新言語のデファクト標準と衝突する場合はツール既定（ruff=spaces）に委ね、非標準化する側に立証責任を置く | steering（tech / conventions）に「新言語のフォーマットはツール既定を正とし、既存 editorconfig を無条件適用しない」 |
| pyright strict は `uv run pyright`（venv 解決）で起動する。直叩き（`.venv/bin/pyright`）は既存ファイルまで `reportMissingImports` 誤検出。autouse fixture は `# pyright: ignore[reportUnusedFunction]` | AGENTS.md「Python（services/agent）」節に「pyright は `uv run` 経由、autouse fixture は ignore 明示」を追記候補 |
| FastAPI `Depends()` は ruff B008 誤検知 → `extend-immutable-calls` に `fastapi.Depends/Query/Path/Body` を設定（実装回避でなく設定の根本修正） | `pyproject.toml` に設定済み。Python サービス標準設定として README/steering に明記候補 |
| async route から LlamaIndex evaluator を呼ぶ場合は同期 `evaluate()` でなく `aevaluate()`（同期版はイベントループ内で `asyncio.run()` 相当が走りデッドロック） | AGENTS.md「Python（services/agent）」節に「FastAPI async route 内の LlamaIndex は `aevaluate` を使う」を追記候補 |
| `_Boundary:_` 宣言外の必須ファイル変更（`.gitignore`/`main.py` router 配線/`uv.lock`/`.python-version`）は ship-gate で検出し tasks.md 境界へ追記して契約を実態へ一致させる | tasks 生成時に「scaffold/配線で必ず触る周辺ファイル（lockfile・`.gitignore`・エントリの router 登録・`.python-version`）を各 Task の `_Boundary:_` に予め含める」を候補ルール化 |

## Process Improvements

- **Check フェーズの実装 grep 裏取りは producer の「存在」だけでなく「呼び出され方」まで踏み込む**:
  Phase A の反省で導入した「Check 自体に全 SHALL 要件の実装 grep を組み込む」は、本サイクルでは
  「ヘルパーが存在し単体テストが通るか」の確認に留まり、「そのヘルパーが本番コードパスから
  実際に呼ばれているか」の確認が漏れて Req 2.7b を見逃した（`/adversarial-review` が検出）。
  次回以降は「SHALL emit/record」型要件について `grep -rn '<helper>' <production_dir>` を実行し、
  ヒットが定義ファイルのみでないことまで確認する（上記 Mistake Record 参照）。
- **分割タスクの Red-Green 判定を着手前に固定する**: 4.2→4.5・5.4→5.5（明示分割・委譲）と
  4.3/4.4/5.2（後続テストタスク無し・自タスクで RED）が Phase B 内で混在した。着手前に当該タスクの
  `_Depends:_` 連鎖を確認し、do.md 過去エントリの申し送り（「Red-Green を 4.5 に委ねる」等）を検索して
  前例を取り違えない——今回は正しく判別できたので、この確認手順を tasks 生成時の注記として明文化する。
- **`_Boundary:_` に周辺必須ファイルを先回りで含める**: out-of-bounds 補正が Task 4/5 の 2 回発生した
  （いずれも scaffold/配線に必須で下流契約に無影響）。lockfile・`.gitignore`・エントリの router 登録・
  `.python-version` など「新規サービスで必ず触る周辺ファイル」を tasks 生成時点で各 Task 境界へ含めておくと
  ship-gate での事後補正を減らせる。

## Next Actions

- **Req 2.7b の配線判断（未解決、優先）**: `traced_span` を `/eval/*` ルートへ配線するか、Phase E へ
  明示委譲するかを決める。委譲の根拠になり得るのは「`EvalRequest`（Req 2.2 の契約）に `case_id`/
  `job_id` が無いのは正しい——相関 ID は呼び出し元（nightly runner、Phase E）が保持するものであり、
  eval リクエスト自体の入力ではない」という設計判断だが、これは do.md/spec.md に明記されていない
  ため次サイクルで正本化するか、本サイクル内で `traced_span("eval.faithfulness",
  model=judge.model_name)` のような呼び出し元を持たない属性のみの span を先行配線するかを判断する。
  いずれにせよ tasks.md か spec.md に「Req 2.7b の配線は Phase E 側の責務」である旨を明記し、
  次回 Check がこれを「未実装」と再度誤検出しないようにする。
- **Phase C（Task 6）着手可**: FastAPI OpenAPI → `openapi-typescript` → `packages/schemas/src/generated/
  agent-service.ts`（コミット）+ 薄い手書き Zod + 契約ドリフトテスト。M2 完了に必要な残要件。
  `openapi-typescript` は install script 有無を確認し `allowBuilds` へ監査エントリ + `minimumReleaseAge` 尊重。
- **Phase D（Task 7）着手可**: `POST /parse`（Docling `HybridChunker`）+ `retrievedChunkSchema` の
  optional `locator`。Phase C と互いに素なため並走可（tasks-parallel-analysis Wave C/D、共に Task 5 依存）。
- **`to_token_usage` の `total_tokens` 再計算**（LOW、`/adversarial-review` 指摘）: `usage.input_tokens
  + usage.output_tokens` が provider 報告の `usage.total_tokens`（cache/reasoning tokens 含む可能性）を
  無視している。`llama.py` に「boundary の total は input+output と定義する」旨のコメントを足すか、
  `usage.total_tokens` を使うかを Phase C/E のどこかで判断。
- **routes の bare `assert` を明示例外化検討**（LOW）: `eval.py:49,67` の `assert judge.last_usage is
  not None` は `python -O` で無効化される。次回 Python タスクで `RuntimeError` への置き換えを検討。
- **steering / AGENTS.md 反映**: 上表の候補ルール（二トラックゲート / 横断ゲート拡張の 3 点セット /
  分割タスク Red-Green 判定 / Python pyright・ruff・async 注意点 / `_Boundary:_` 周辺ファイル / Check の
  「ヘルパー呼び出し確認」grep）を次の steering 更新でまとめて取り込む。
- **Serena メモリ更新**: `patterns/polyglot-sidecar-isolation-seam` を追加（Step 5 で実施）。
