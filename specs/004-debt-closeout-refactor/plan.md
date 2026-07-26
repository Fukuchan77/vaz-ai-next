# 004-debt-closeout-refactor — Technical Plan

散文は日本語、識別子・型・パス・コードは英語(`spec.json` `language: ja`)。

## Summary

棚卸し(2026-07-24)が確定した「トリガー無しで着手可能な実債務」を 4 フェーズで消化する:
(1) `@vaz/db` 分割(R2)、(2) CI ゲート配線(R5)、(3) ドキュメント整合 + allowlist docstring
是正(R3/R4)、(4) M3 locator E2E 修正 + 任意の sidecar compose profile(R6/R7)。
トリガー待ち項目は spec.md の台帳(R1)として確定し、コードは触らない。

コード挙動の変更は R6 のテストコード修正のみ。R2 は純粋なファイル移動 + import 書換
(refactor-only、NFR-2)、R5 は自動化配線、R3/R4 は文言修正である。

## Architecture Overview

### R2 後の依存グラフ

```
@vaz/schemas (leaf)     @vaz/db (leaf; drizzle-orm/drizzle-zod/zod のみ)
      │                     │
      ├──────┬──────────────┤
      ▼      ▼              ▼
 @vaz/config @vaz/tools  @vaz/rag(ingest/retrieve — drizzle-orm+pg は残置)
      │      │              │
      └──────┴──────┬───────┘
                    ▼
               @vaz/agents
                    │
      ┌─────────────┼─────────────┐
      ▼             ▼             ▼
   apps/web     apps/worker   @vaz/evals
                (rag 依存は db へ置換)
```

- `@vaz/db` は `@vaz/schemas` と並ぶ第 2 のリーフ。runtime import は drizzle-orm /
  drizzle-zod / zod のみ(`@vaz/schemas` は移動したドリフトガードテスト専用の devDependency)。
- `pg` は `@vaz/db` に含めない — pool は従来どおり composition root
  (`packages/rag/bin/ingest.ts` / `apps/worker/src/start.ts` / `apps/web/src/lib/db.ts`)所有。

## Components

### packages/db(新設 / R2)

- `package.json`: source-only 慣例(`"exports": {"./*": "./src/*.ts"}`、echo typecheck script)。
- `src/schema.ts`: 旧 `packages/rag/src/db/schema.ts` の全量移動。ヘッダ docblock の
  「lives in `@vaz/rag` only because … a dedicated `@vaz/db` split is a later refactor」段落を削除。
- `drizzle/0000_add_locator.sql`: 旧 `packages/rag/drizzle/` から移動(内容無変更)。
- `tests/schema.spec.ts`: 旧 `packages/rag/tests/schema.spec.ts` から移動。import は
  self-referencing specifier(`@vaz/db/schema`)へ。root vitest の `packages/*/tests/**` glob と
  coverage include `packages/*/src/**` が無設定変更で拾う。

### import 書換(R2.3)

`@vaz/rag/db/schema` → `@vaz/db/schema` の全量書換(grep 検証で 16 コードファイル +
コメント/README 参照)。再 export シムは置かない(全利用者がリポジトリ内のため)。

### package.json 依存更新(R2.4)

| package | 変更 | 根拠 |
| --- | --- | --- |
| `@vaz/rag` | +`@vaz/db`、−`drizzle-zod` | schema.ts が drizzle-zod の唯一の利用者だった |
| `apps/worker` | `@vaz/rag` → `@vaz/db` | stores.ts の schema import が唯一の rag 利用だった |
| `@vaz/evals` | +`@vaz/db` | unit specs が `EMBEDDING_DIM` を import(rag 依存は retrieve/tools 用に残る) |
| `@vaz/agents` | devDeps +`@vaz/db` | テストのみが `EMBEDDING_DIM` を import |

`apps/worker/Dockerfile` は `COPY . .` + `pnpm deploy` のため変更不要(workspace graph が解決)。

### CI ゲート配線(R5)

- `lint.yml`: checkout 直後に `bash scripts/forbid-model-ids.sh`(install 不要 → fail-fast)。
- `.githooks/pre-commit`: step 5/5 に `mise run lint:model-ids`、ヘッダの「check-only」文言修正。
- `python.yml`(新設): `on: push: paths: [services/agent/**, mise.toml, 自 workflow]` →
  `jdx/mise-action@v4` → `mise run py:check`。`mise.toml` `[tools]` に `uv = "0.9"` をピン。
  `tests.yml` の `gate` には入れない(path-filter 付きジョブは `needs`+`if: always()` 集約を壊す /
  `py:check` を `check` 外に置く既存スタンス)。
- `vitest.config.ts`: coverage exclude に `packages/evals/src/pr-gate.ts`(nightly.ts と同型
  コメント)。トレードオフ: pure 関数のカバレッジ統計は消えるが、`tests/pr-gate.spec.ts` は
  走り続ける。代替案(pure 関数の `pr-gate-metrics.ts` 抽出)は diff 増のため不採用・記録のみ。

### ドキュメント整合(R3/R4)

- AGENTS.md: 「Active Spec: 002」→ 恒久「Python sidecar」節、ingest CLI 行、dep-graph 記述、
  002 レトロ steering 4 件を「Design & process rules」節として追加。
- CLAUDE.md: パッケージ数 6→7、dep-graph ミラー文。
- `packages/tools/src/allowlist.ts`: docstring を「配線済み(email.ts が配送前に
  `assertAllowedRecipient` を呼ぶ)」へ。

### E2E 修正(R6)+ sidecar profile(R7)

- 3 spec の `getByText("You")` → `getByText("You", { exact: true })`(理由コメント付き)。
- `DISTINCTIVE_FACT` にセンチネル文を追記(行末 OCR 欠落がセンチネルを食う設計、コメント付き)。
  アサーション(`CODENAME` / `"locator"`)無変更。
- `services/agent/Dockerfile`(uv ベース、deps layer 先行、非 root)+ compose `sidecar`
  サービス(`profiles: ["sidecar"]`、healthcheck は `/healthz` を Python urllib で probe)。

## Error Handling / Edge Cases

- **schema 移動の見落とし検出**: 移動後に `@vaz/rag/db/schema` の残存 grep がゼロ件であることを
  ゲートに含める(1 件でも残ると Node ESM 解決が即座に throw するため実行時にも fail-loud)。
- **coverage 閾値の変動**: `pr-gate.ts` 除外で全体カバレッジは上がる方向(73.91% のファイルが
  分母から外れる)。閾値 80 の再確認を R2/R5 双方の後に実施。
- **python.yml の初回実行**: 本 spec のブランチ push 自体が `services/agent/**`(Dockerfile 追加)
  に触れるため、path-filter 発火の初回観測を兼ねる。

## Verification

| Phase | 実施(本セッション) | 委譲(CI / ローカルスタック) |
| --- | --- | --- |
| R2 | biome / `pnpm -r typecheck` / vitest 全 project / coverage 閾値 / `forbid-model-ids.sh` / `pnpm audit`(pre-commit フック経由でも全通過) | `apps/worker/Dockerfile` の実ビルド |
| R5 | workflow YAML パース検証 / `forbid-model-ids.sh` ローカル実行 / coverage 再実行 | push 後の `lint.yml`/`python.yml` 実走(python.yml は本ブランチで初回発火) |
| R3/R4 | stale 文言の残存 grep ゼロ確認 / vitest green | — |
| R6/R7 | `pnpm exec playwright test --list`(パース確認)/ `docker compose --profile sidecar config` | `mise run test:e2e:ollama` 実走(docker+Ollama 到達環境。6.3 の [E] 節) |

## Decisions(採用/不採用)

- カット線 = schema 全体移動(採用)/ workflow テーブルのみ(不採用: `EMBEDDING_DIM`・contract
  所有の分裂)。
- drizzle-kit 採用は含めない(台帳へ。トリガー: 次の DDL 変更)。
- `pr-gate.ts` は単純 exclude(採用)/ pure 関数抽出(不採用: diff 増、記録のみ)。
- `python.yml` は non-blocking・`gate` 外(採用)/ required 化(不採用: path-filter と required
  check の相性、`py:check` の既存スタンス)。
- R7 は opt-in profile として採用(既定 compose 無影響)。bare-metal uvicorn 起動は第一級のまま。
