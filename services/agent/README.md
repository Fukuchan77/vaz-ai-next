# vaz-agent-service

`@vaz/*` の依存グラフ外にある、**ステートレス**な Python サイドカーです（Req 2.1/2.3）。
LlamaIndex を用いた RAG 評価（Faithfulness/Relevancy、Task 5）と Docling による構造保持
パーシング（`/parse`、Task 7）を HTTP で提供します。DB・Redis・ファイルシステムには一切
触れません — 評価/解析に必要な入力はすべてリクエスト自体に含まれます。

TS 側の `@vaz/*` パッケージとは独立に、uv でローカル管理される単体プロジェクトです
（`pyproject.toml`、pyright strict、`mise run py:check` は `check` 集約タスクの非依存 — NFR-1）。

## セットアップ・起動（`uv run`）

前提: [uv](https://docs.astral.sh/uv/) がインストール済みであること。Python 3.13 系は uv が管理します。

```bash
cd services/agent
uv sync                                   # 依存を仮想環境へ同期
uv run uvicorn app.main:app --reload --port 8000
```

env はデフォルトで無設定でも起動する（`JUDGE_PROVIDER=anthropic` は `ANTHROPIC_API_KEY`
未設定でも起動自体は失敗しない — judge 呼び出し時に初めて必要になる、Task 5）。
上書きする場合は `services/agent/.env`（`app/config.py` が `pydantic-settings` で読み込む、
`.gitignore` で除外済み）またはシェル env で設定する（下表）。

起動確認:

```bash
curl http://localhost:8000/healthz
# => {"status": "ok"}
```

## 品質ゲート

```bash
mise run py:check       # uv sync + ruff check + pyright + pytest（services/agent 配下で実行）
```

個別に実行する場合:

```bash
uv run ruff check .     # lint
uv run pyright          # 型チェック（strict）
uv run pytest           # 単体テスト（ネットワークゼロ — httpx.ASGITransport / TestClient）
```

`uv run pytest` は必ず rootdir（`services/agent`）から実行する。`[tool.pytest.ini_options]` の
`pythonpath = ["."]` がその rootdir を `sys.path` へ追加することで `tests/conftest.py` の
`from app...` importが解決する（`[tool.uv] package = false` のため `uv sync` は本プロジェクトを
editable install しない）。

`py:check` は `mise run check`（TS 側の集約ゲート）に含まれません。Python ツールチェーンが
無い環境でも TS 側のゲートは緑を維持します（NFR-1）。

## 環境変数

このプロセス自身が読む env（`app/config.py`、`pydantic-settings` で検証、`.env` 読み込み対応）:

| 変数                 | 既定値                          | 説明                                                                    |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `JUDGE_PROVIDER`     | `anthropic`                       | 評価 judge の LLM プロバイダ。`anthropic` \| `ollama`（OpenAI 非対応、既存 TS 側の provider-agnostic 方針と一致）。 |
| `JUDGE_MODEL`        | プロバイダごとの既定（下記）      | judge モデル ID。`app/config.py` の `JUDGE_MODEL_ALLOWLIST` に無い値は起動時に拒否される（NFR-2 の carve-out 対象ファイル）。 |
| `ANTHROPIC_API_KEY`  | 未設定                           | `JUDGE_PROVIDER=anthropic` のとき使用。                                    |
| `OLLAMA_BASE_URL`    | `http://localhost:11434/v1`      | `JUDGE_PROVIDER=ollama` のとき使用する OpenAI 互換エンドポイント。          |

`JUDGE_MODEL` 未設定時のプロバイダ別既定値は `app/config.py` の `DEFAULT_JUDGE_MODEL`
（`anthropic` → `claude-opus-4-8`、`ollama` → `llama3.2`）。モデル ID のハードコードは
`app/config.py` のみ許可される（`scripts/forbid-model-ids.sh` の carve-out、他の
`services/**/*.py` にモデル ID を直書きすると lint が落ちる）。

呼び出し側（TS 側）が読む env は本サービスの管轄外だが参考として記載: nightly runner と
ingest CLI（`--via-parser`）は `AGENT_SERVICE_URL` でこのサービスの到達先を解決する
（例: `AGENT_SERVICE_URL=http://localhost:8000`。Task 8/9 で配線）。

## サービス間トークン方針（S2S token / NFR-4・ADR-C）

**このサービスはブラウザに公開しない。** 呼び出し元は次の 2 者のみ:

- nightly 評価ランナー（`packages/evals` の tier2、Task 9）
- ingest CLI の `--via-parser` 経路（`packages/rag`、Task 8）

いずれも内部ネットワーク経由で、サービス間トークン（S2S token）を用いて到達する想定
（トークン発行・検証の実装は Out of Scope — 本 spec は Phase B のコンテナ化/本番配備要件を
含まない。ADR-C）。ユーザーがブラウザから直接到達できる経路は存在しないため、JWT
ミドルウェアは現時点で要件化していない — 将来 spec でユーザー到達可能なパスをこのサービスに
追加する場合にのみ、その時点で JWT 検証ミドルウェアの追加を要件とする（NFR-4）。

`docker-compose.yml` への統合（コンテナ化・ネットワーク分離）は本番配備要件が明確になった
時点で追補する（ADR-C）。現状はローカル `uv run` 起動のみを前提とする。

## テレメトリ・プライバシー

`app/telemetry.py` が fail-soft に OTel を初期化する（OTel Collector 未設定でも起動は失敗しない）。
ログ・スパン属性には `caseId`/`jobId` などの識別子のみを載せ、生の question/answer/context 本文は
一切出さない（R4.7 privacy contract、Req 2.7/NFR-3）。監査ログの永続化はこのサービスの責務では
なく、呼び出し元 TS 側の `deps.audit`（単一発火点）が担う。

## エンドポイント

| メソッド | パス                | 状態                     | 説明                                                        |
| -------- | ------------------- | ------------------------ | ------------------------------------------------------------ |
| `GET`    | `/healthz`           | 実装済み                 | liveness probe。外部依存に触れない（Req 2.3）。                |
| `POST`   | `/eval/faithfulness` | Task 5 で実装             | `{question, contexts, answer}` → `{score, verdict, judge_model, usage}`。 |
| `POST`   | `/eval/relevancy`    | Task 5 で実装             | 同上。                                                        |
| `POST`   | `/parse`             | Task 7 で実装             | ドキュメント → `{source, locator, ordinal, text}[]`（Docling 既定、LlamaParse opt-in）。 |
| `GET`    | `/openapi.json`      | FastAPI 標準              | Phase C（`openapi-typescript` → `packages/schemas/src/generated/agent-service.ts`）の型生成元。 |

## ディレクトリ構成

```text
services/agent/
  pyproject.toml       # uv 管理の依存定義（pyright strict, dependency-groups.dev）
  uv.lock
  app/
    __init__.py
    config.py           # env 検証 + judge model allowlist（モデル ID 直書きの唯一の許可場所）
    main.py              # FastAPI app 構築 + /healthz + telemetry フック
    telemetry.py          # fail-soft OTel 初期化 + サニタイズ済みログユーティリティ
  tests/
    test_config.py
    test_main.py
    test_telemetry.py
```
