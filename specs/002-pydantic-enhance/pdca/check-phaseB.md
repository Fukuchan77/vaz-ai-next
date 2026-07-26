# Check Phase — 002-pydantic-enhance（Phase B）

PDCA Check: Do フェーズの実装結果を、Phase B（Python 評価サイドカー / Req 2 + NFR-1〜5、
Task 4→5）の期待に照合する。`/sdd-reflect 002-pydantic-enhance PhaseB` により生成
（`pdca/plan.md` 不在のため期待値は `spec.md` Req 2.1–2.7・NFR-1〜5、`tasks.md` Task 4/5、
`plan.md` File Structure Plan を正本として抽出）。

**Phase A の学びの適用**: 前サイクル（Phase A）で Check が `do.md` の自己申告だけを正本にして
Req 1.5 を過大評価した反省（`.sdd/mistakes/002-pydantic-enhance-2026-07-19.md`）を踏まえ、本 Check は
各 SHALL 要件を実装ファイルへの直接 grep で裏取りした（下表 Verified 列）。

**訂正（`/adversarial-review` 起因）**: 初版は「Phase B は契約と配線の乖離ゼロ」と結論したが、
フレッシュコンテキストの `/adversarial-review` が Req 2.7 で同型の欠陥を検出した——
`traced_span`/`get_tracer`/`get_logger`（`telemetry.py`）は実装済み・単体テスト green だが、
`/eval/*` の 2 ルートからは一度も呼ばれていない（`grep -rn 'traced_span' services/agent/app` が
`telemetry.py` の定義のみを返す）。初版の grep セット（エンドポイント存在・ステートレス性・
import 方向・`py:check`・model-id・network-zero・privacy ログ）は「ヘルパーが存在し単体テストが
通るか」までしか裏取りせず、「そのヘルパーがリクエスト経路から実際に呼ばれるか」を確認していな
かった——Req 1.5 で確立したはずの予防策（producer への直接 grep）が、"契約=関数の存在" と
"配線=呼び出し元での実際の使用" を今回も混同する形で再現した。下表 Req 2.7 行と Assessment を
本訂正で修正。詳細: `.sdd/mistakes/002-pydantic-enhance-2026-07-20-req2.7.md`。

## Expectations vs. Results

| Expectation（spec / tasks） | Result（do + 実装 grep） | Verified | Status |
|---|---|---|---|
| Req 2.1 `services/agent`（FastAPI+Pydantic AI+LlamaIndex, uv, pyright strict）を `@vaz/*` 依存グラフ外に置き、TS からの import も TS への import も無し（HTTP 境界のみ） | `services/agent/` 新設、`[tool.pyright] strict`。TS→services/agent の import ゼロ、services/agent→TS の import ゼロ | `grep -rn "services/agent" apps packages --include=*.ts` → 0 件；`app/**` に workspace import 無し | ✅ |
| Req 2.2 `POST /eval/faithfulness`・`/eval/relevancy`、`{question,contexts,answer}`→`{score,verdict,judge_model,usage}` | `app/routes/eval.py` に両エンドポイント、`main.py` で `include_router(eval_router)` 配線。I/O は `app/schemas.py`（`EvalRequest`/`EvalResponse`/`TokenUsage`） | `@router.post("/faithfulness")`・`/relevancy` + `app.include_router(eval_router)` を実確認 | ✅ |
| Req 2.3 ステートレス（DB/Redis/FS 永続なし、入力は全てリクエスト） | `app/` に DB/Redis/FS アクセス無し。`/healthz` も外部依存に触れず `{"status":"ok"}` のみ | `grep -rnE 'psycopg|asyncpg|redis|sqlalchemy|open\(|aiofiles|boto3' services/agent/app` → 0 件 | ✅ |
| Req 2.4 ユニットテストレーンはネットワーク I/O ゼロ（judge の決定論フェイク + `httpx.ASGITransport`） | `conftest.py` の `async_client`（`ASGITransport(app=app)`）+ `judge_llm_factory`/`deterministic_judge_llm`（`pydantic_ai.models.test.TestModel`）、`app.dependency_overrides[get_judge_llm]` で注入 | `ASGITransport`・`TestModel`・`dependency_overrides` を tests に実確認 | ✅ |
| Req 2.5 `py:check`（uv sync+ruff+pyright+pytest）が存在し、`check` 集約の依存では**ない** | `mise.toml` `[tasks."py:check"]`（`dir="services/agent"`, run 配列）。`[tasks.check].depends` は不変 | `depends = ["lint","typecheck","test:run","audit","lint:model-ids"]`（`py:check` 不在）を実確認 | ✅ |
| Req 2.6 judge model を env から `config.py` の in-file allowlist で検証、`services/**` の他所にモデル ID 直書き禁止 | `config.py` の `JUDGE_MODEL_ALLOWLIST` + `model_validator` で allowlist 外を `ValueError`。allowlist 先頭へフォールバック | `services/agent/app` 内のモデル ID は `config.py:25-26` の 2 件のみ | ✅ |
| Req 2.7a 起動時 fail-soft（collector 未設定でも起動失敗しない） | `main.py` の lifespan が `init_telemetry()` を呼ぶ（`ProxyTracerProvider` 検知 → warn-once, idempotent） | `main.py:18,23` で `init_telemetry` 呼び出しを実確認、`test_main.py` で lifespan 起動時 1 回呼ばれることを検証 | ✅ |
| Req 2.7b span 属性が `gen_ai.*` + `caseId`/`jobId` を再利用（**リクエスト経路で実際に emit される**こと） | `telemetry.py` に `traced_span`（`case_id`/`job_id`→`caseId`/`jobId`, `**gen_ai_*`→`gen_ai.*`）を実装、`test_telemetry.py` 6/6 green | `grep -rn 'traced_span' services/agent/app` → **`telemetry.py` の定義のみ**。`app/routes/eval.py` の 2 ハンドラは `traced_span`/`get_tracer`/`get_logger` を一度も呼ばない。`EvalRequest`（`schemas.py`）にも `case_id`/`job_id` フィールドが無く、呼び出し元から相関 ID を渡す経路が無い | ❌（capability 実装・単体テスト済みだが未配線。Req 1.5 と同型の欠陥、`/adversarial-review` で検出） |
| NFR-3 は Req 2.7b とは別軸（raw 本文をログに出さないこと）で満たされる | `app` 内に raw question/answer/context をログ出力するコードは存在しない | `grep -rnE 'log.*(question\|answer\|context)' services/agent/app` → 0 件（span 未配線でもログ非出力は別途保証されている） | ✅ |
| NFR-1 既存受入ゲート（`mise run check`・coverage・`lint:model-ids`・git hooks・供給網）を常時緑、各フェーズ独立着地 | Task 4.1〜5.5 の各サブタスクで `mise run check` を再実行し TS 側 465 tests green を実測、Python 追加が TS ゲートに一切影響しないことを裏取り | Phase B 全編で TS 側テスト数 465 不変 | ✅ |
| NFR-2 `forbid-model-ids.sh` を `services/**` `*.py` へ拡張、`config.py` を carve-out（免除追加でなく走査拡張、TS carve-out 不変） | `--include='*.py'` + 走査対象に `services` 追加 + `.venv`/`__pycache__` 等の `--exclude-dir` + `services/agent/app/config.py` のみ carve-out | スクリプト実体を実確認、`telemetry.py` docstring は carve-out でなく実コード修正で解消 | ✅ |
| NFR-3 R4.7 プライバシー契約（raw question/answer/context をログに出さない、識別子のみ） | `telemetry.py` の `get_logger` docstring に「識別子のみ」契約明記。app 内に raw 本文ログ無し | `grep -rnE 'log.*(question\|answer\|context)' services/agent/app` → 0 件 | ✅ |
| NFR-4 ブラウザ非公開、呼び出し元は nightly runner + ingest CLI、S2S トークン、JWT は将来ユーザーパス時のみ | JWT ミドルウェアは**意図的に未実装**（未配線設定フィールドを作らない、gap-analysis の「将来 spec 条件付き」判定に従う）。`README.md` が運用方針（内部ネットワーク限定・ブラウザ非公開）を文書化 | README + config.py にトークンフィールド不在を実確認 | ✅ |
| NFR-5 Python 依存は uv-lock + `pip-audit`（監査済み供給網判断） | `uv.lock` コミット、`pip-audit` を dev group + `py:check`/ship-gate で実行 | `uv run pip-audit` → `No known vulnerabilities found` | ✅ |

## Test & Quality Outcomes

- Python tests: `mise run py:check` → **46 passed**（`test_config.py` 11 + `test_eval.py` 8 +
  `test_llama.py` 19 + `test_main.py` 2 + `test_telemetry.py` 6）。本 Check 生成時に実再実行し実測確認。
- Python lint/type: `uv run ruff check .` → `All checks passed!`、`uv run pyright`（strict）→
  `0 errors, 0 warnings, 0 informations`。
- 供給網 / model-id: `uv run pip-audit` → No known vulnerabilities、`bash scripts/forbid-model-ids.sh`
  → `✅ No hardcoded model IDs found (apps/**, packages/**, services/**)`（`services/**/*.py` 走査 +
  `config.py` carve-out が実測で有効）。
- TS 側回帰（NFR-1）: `mise run check` は Phase B 全編で不変緑（48 files / 465 tests、lint
  `Checked 127 files. No fixes applied.`、typecheck 全 workspace green、audit clean、lint:model-ids ✅）
  —— Python トラック追加が TS 受入ゲートに一切影響しないことを各サブタスクで裏取り。
- Performance: Phase B に定量目標なし（該当なし）。

## Requirements Coverage

- Covered: Phase B スコープ **11/12（91.7%）**（Req 2.1–2.6 の 6 + Req 2.7a + NFR-1〜5 の 5）。
- Gap: **Req 2.7b（span 属性のリクエスト経路での実 emit）が未配線**（`/adversarial-review` 検出、上表参照）。
  `traced_span`/`get_tracer`/`get_logger` は実装・単体テスト済みだが `/eval/*` ルートから未呼出、
  `EvalRequest` に `case_id`/`job_id` の入力経路も無い。Phase A の Req 1.5 と同型の「契約/capability のみ・
  配線欠落」パターンが本サイクルでも再現した（初版 Check はこれを見逃していた、後述 Assessment）。
- Deferred / 意図的未実装: JWT ミドルウェア（NFR-4 の一部）は仕様上「将来ユーザーパス追加時のみ」
  条件付きのため未実装が正解（欠落ではない）。OTel SDK/exporter も未導入が正解（Req 2.7a は
  「collector 未設定でも起動」を要求し、no-op spans + 依存ゼロで字義通り充足）。
- Out of scope: Req 3（Phase C 契約生成）・Req 4（Phase D `/parse`）・Req 5/6（Phase E）は本 reflect 対象外。

## Deviations from Design

- **`aevaluate()`（async）採用 — plan の低レベル `evaluate()` から逸脱（Task 5.2）**: LlamaIndex の
  `FaithfulnessEvaluator`/`RelevancyEvaluator` は `is_chat_model=True` の LLM に対し
  `aevaluate()`→`apredict`→`achat` のみを呼ぶ。FastAPI の async route 内で同期 `evaluate()` を
  呼ぶと内部で `asyncio.run()` 相当が走りデッドロックするため、async-only 化は正当な逸脱
  （docstring に根拠明記）。
- **`PydanticAIJudgeLLM.agent` を `Any` 型に（Task 5.2）**: `Agent[None, str]` を pydantic フィールドに
  厳密指定すると pydantic-graph 内の未解決 forward reference で解決不能。呼び出し側は常に実
  `Agent[None, str]` を渡す前提をテストで保証。
- **OTel の optional import を不採用、`ProxyTracerProvider` 検知に変更（Task 4.3）**: `try/except
  ImportError` は pyright strict が `reportMissingImports` を出す（静的解析は try/except を見ない）ため
  不採用。既定 provider 検知で依存追加ゼロのまま Req 2.7 を充足。
- **JWT/S2S トークンフィールドを config.py に追加しない（Task 4.2）**: 未配線ミドルウェア用の設定
  フィールドを先取りで生やすと「半端な実装」になる（CLAUDE.md 禁止）。gap-analysis の NFR-4 判定に従い
  README で運用方針を文書化するに留めた。
- **`.editorconfig` の tab を Python に適用せず ruff 既定（spaces）に委譲**: repo-wide の
  `indent_style = tab` は TS/Biome 前提。新言語のデファクト標準（PEP 8）と衝突する場合はツール既定に
  委ねる方が握持コストが低いと判断（`[tool.ruff.format]` override 追加せず）。
- **ruff bugbear `extend-immutable-calls` 追加（Task 5.4）**: `Depends(get_judge_llm)` を B008
  （可変デフォルト引数）と誤検知するため、FastAPI 公式に知られた ruff 相互作用への標準修正として
  `fastapi.Depends/Query/Path/Body` を immutable 扱いに設定（実装側の回避でなく設定漏れの根本修正）。

## Issues Encountered

| Issue | Root cause | Resolution |
|---|---|---|
| `.venv/bin/pyright` 直叩きで既存ファイルまで `reportMissingImports` 誤検出 | pyright が venv の site-packages を解決できない | `uv run pyright`（venv 解決）経由に統一。`py:check` もこの呼び出し形を採用 |
| autouse fixture（`_clean_env`/`_clear_dependency_overrides`）に `reportUnusedFunction` | strict は呼び出し元コードから見えない fixture を未使用と誤検知 | 関数定義行に `# pyright: ignore[reportUnusedFunction]`（`test_telemetry.py` の既存パターンと同型） |
| `Depends(get_judge_llm)` が ruff B008 で誤検知 | FastAPI DI 慣用パターンを bugbear が未知 | `pyproject.toml` に `extend-immutable-calls` を追加（上記 Deviation） |
| pyright strict の `UP037`/`UP043`/`reportDeprecated`（`AsyncIterator`→`AsyncGenerator`） | `from __future__ import annotations` 環境・冗長型引数・`@asynccontextmanager` の戻り値注釈 | `--fix` / 型注釈修正で解消、再実行で 0 errors |
| Task 4/5 で `_Boundary:_` 宣言外のファイルが変更（Task4: `.gitignore`；Task5: `main.py`/`pyproject.toml`/`uv.lock`/`.python-version`） | scaffold/実装に必須だが major boundary に未列挙（`.python-version` は uv 生成の未追跡ファイルが初回追跡化） | いずれも下流契約に影響せず必須のため、ship-gate で tasks.md の該当 Task 境界へ追記し契約を実態へ一致（out-of-bounds 補正） |
| Req 2.7 の span 属性が `/eval/*` から一度も呼ばれない（`/adversarial-review` 検出、上表 Req 2.7b） | `telemetry.py` の `traced_span` を Task 4.3 で作成した際、「後続タスクが利用する」前提の薄いラッパとして実装したが、Task 5.4（ルート実装）がこれを呼び出す配線を実際には追加しなかった。`EvalRequest` にも相関 ID フィールドが無い | 未修正（Phase B の必須 SHALL には含まれない capability だが、Req 2.7 の字義には「span 属性は再利用される」とあり `traced_span` が呼ばれない限り字義通りの充足ではない）。Next Actions で Phase E（nightly runner が `caseId`/`jobId` を保持する側）へ配線を委譲するか、本サイクル内で修正するかを次アクションで判断 |

**確認済みで問題なしと判定**: (a) `services/agent/tests/*.py` は `forbid-model-ids.sh` の既存
`grep -vE '(^|/)tests/'` パターンにパスが一致するため Python 用 carve-out 新設不要で自動除外
（TS 側ルールの再利用）。(b) `async_client` は lifespan（`init_telemetry`）を走らせないが、eval
エンドポイントは telemetry 初期化に非依存で、lifespan 自体は `test_main.py` が `TestClient` で別途検証済み。

## Assessment

Phase B（Python 評価サイドカー）は当初 Req 2.1–2.7 + NFR-1〜5 を「12/12（100%）」と自己照合したが、
`/adversarial-review` をフレッシュコンテキストで実行したところ **Req 2.7 の後半（span 属性の
リクエスト経路での実 emit）が未配線**であることを検出した——`traced_span`/`get_tracer`/`get_logger`
は実装済み・単体テスト green だが `/eval/*` の 2 ルートから一度も呼ばれず、`EvalRequest` にも
`case_id`/`job_id` の入力経路が無い。これは Phase A の Req 1.5（「supervisor SHALL emit run-metrics」を
契約追加のみで ✅ 誤判定）と**同型の欠陥**であり、初版 Check の grep セット（エンドポイント存在・
ステートレス性・import 方向・`py:check`・model-id・network-zero・privacy ログ）が「ヘルパーが存在し
単体テストが通るか」までしか裏取りせず「そのヘルパーがリクエスト経路から実際に呼ばれるか」を
確認していなかったことが原因（Req 1.5 で確立したはずの予防策が producer 側の呼び出し確認まで
徹底されていなかった）。訂正後の実質カバレッジは **Req 2.1–2.6 + 2.7a（起動時 fail-soft）+
NFR-1〜5 = 11/12（91.7%）**、Req 2.7b は Gap として明示。

それ以外の実装は堅牢——`/eval/*` 2 エンドポイントは実際に `include_router` で配線され、judge 解決・
verdict/score 写像・token 集計まで実装が通っている。46 Python テストが green（ネットワークゼロ）、
ruff/pyright strict/pip-audit/forbid-model-ids 全緑。NFR-1 の核心（`py:check` を `check` 集約の
非依存に保ち、Python 追加で TS 側 465 tests が不変緑）を各サブタスクで実測裏取り——ポリグロット化が
既存の単一言語ゲートを一切劣化させていない。設計逸脱 6 件はいずれも要件充足のための正当な判断
（async 化 / 型回避 / 依存ゼロ fail-soft / 未配線フィールド不作成 / ツール既定委譲 / bugbear 設定）で
do.md に根拠記録済み。out-of-bounds なファイル変更 2 件は ship-gate で境界へ追記し契約を実態へ一致。
**Req 2.7b の配線を除き Phase B は本番投入可能な品質**。M2 の Phase B 部分（`py:check` green・
エンドポイント稼働）は達成、残る M2 要件（契約ドリフトテスト = Phase C / nightly tier2 = Phase E）は
後続フェーズへ。Req 2.7b の配線先（`caseId`/`jobId` を保持する呼び出し元 = nightly runner）は
Phase E で確定する可能性が高く、本サイクル内で先取り配線するか Phase E へ明示委譲するかは
Next Actions で判断（act-phaseB.md 参照）。
