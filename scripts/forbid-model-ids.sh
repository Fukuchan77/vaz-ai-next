#!/usr/bin/env bash
#
# forbid-model-ids.sh — LLM モデル ID 直書き検出ゲート (Task 7.4, R1.8 / ADR-5)
#
# モデル ID は @vaz/config の allow-list を「唯一の合法直書き箇所」とし (R1.8)、
# それ以外の app / package コードへの直書きを禁止する。違反があれば該当箇所を
# 出力して exit 1 で lint ステージを失敗させる。
#
# 走査対象: apps/** と packages/** の *.ts / *.tsx（モノレポの go-forward 構成）。
#   ※ 移行期に残る root ./src は temporary duplication（7.5 で撤去予定）につき対象外。
#
# 合法な直書き (carve-out — ADR-5):
#   - packages/config/**            … model-allowlist.ts（正本）+ provider 解決
#   - packages/schemas/src/env.ts   … env スキーマの .default()（env carve-out）
#   - テスト (*.spec.ts[x] / **/tests/**) … 解決結果を assert するため ID を用いる
#
# サポートするプロバイダは anthropic / ollama のみ（Provider-Agnostic, OpenAI 非対応）。
# 検出パターンは claude- / llama を主軸に、他社モデル (gpt / gemini / qwen / mistral) を
# 防御的トリップワイヤとして含める。
set -euo pipefail

# スクリプトは scripts/ 配下 → リポジトリルートへ移動して相対パスを安定させる。
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 検出する既知のモデル ID リテラル。
PATTERN='claude-[a-z0-9]|llama-?[0-9]|gpt-[0-9]|gemini-[0-9]|qwen[0-9]|mistral-[a-z0-9]'

# apps/** ・ packages/** を走査し、carve-out を除外する。
# （no-match で grep は exit 1 を返すため `|| true` で set -e / pipefail を吸収）
matches="$(
	grep -rEn \
		--include='*.ts' --include='*.tsx' \
		--exclude-dir=node_modules --exclude-dir=.next --exclude-dir=dist \
		-E "$PATTERN" \
		apps packages 2>/dev/null \
		| grep -vE '(^|/)packages/config/' \
		| grep -vE '(^|/)packages/schemas/src/env\.ts:' \
		| grep -vE '\.spec\.(ts|tsx):' \
		| grep -vE '(^|/)tests/' \
		|| true
)"

if [ -n "$matches" ]; then
	echo "❌ [forbid-model-ids] @vaz/config 外にハードコードされた LLM モデル ID を検出しました:"
	echo ""
	echo "$matches"
	echo ""
	echo "→ モデル ID は packages/config/src/model-allowlist.ts（唯一の正本）に集約し、"
	echo "  実行時は @vaz/config#resolveModel が env 経由で解決してください (R1.8 / ADR-5)。"
	exit 1
fi

echo "✅ [forbid-model-ids] ハードコードされたモデル ID はありません (apps/** ・ packages/**)。"
exit 0
