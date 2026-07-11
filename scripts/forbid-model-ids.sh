#!/usr/bin/env bash
#
# forbid-model-ids.sh — hardcoded LLM model-ID detection gate (R1.8 / ADR-5)
#
# Model IDs live in @vaz/config's allow-list as the single legitimate place for
# a hardcoded string (R1.8); hardcoding them anywhere else in app/package code
# is forbidden. On a violation, print the offending locations and exit 1 to fail
# the lint stage.
#
# Scan target: *.ts / *.tsx under apps/** and packages/**.
#
# Legitimate hardcodes (carve-out — ADR-5):
#   - packages/config/**            … model-allowlist.ts (source of truth) + provider resolution
#   - packages/schemas/src/env.ts   … env schema .default() (env carve-out)
#   - tests (*.spec.ts[x] / **/tests/**) … IDs used to assert resolution results
#
# Only the anthropic / ollama providers are supported (provider-agnostic, no OpenAI).
# The detection pattern centers on claude- / llama and includes other vendors
# (gpt / gemini / qwen / mistral) as a defensive tripwire.
set -euo pipefail

# The script lives under scripts/ → move to the repo root so relative paths are stable.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Known model-ID literals to detect.
PATTERN='claude-[a-z0-9]|llama-?[0-9]|gpt-[0-9]|gemini-[0-9]|qwen[0-9]|mistral-[a-z0-9]'

# Scan apps/** and packages/**, excluding the carve-outs.
# (grep returns exit 1 on no match, so `|| true` absorbs it under set -e / pipefail.)
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
	echo "❌ [forbid-model-ids] Detected a hardcoded LLM model ID outside @vaz/config:"
	echo ""
	echo "$matches"
	echo ""
	echo "→ Keep model IDs in packages/config/src/model-allowlist.ts (the single source of truth)"
	echo "  and resolve them at runtime via @vaz/config#resolveModel from env (R1.8 / ADR-5)."
	exit 1
fi

echo "✅ [forbid-model-ids] No hardcoded model IDs found (apps/**, packages/**)."
exit 0
