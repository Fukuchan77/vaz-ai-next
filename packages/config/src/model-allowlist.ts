import type { AiEnv } from "@vaz/schemas/env";

/**
 * Provider union, single-sourced from the env schema (`@vaz/schemas`) so the
 * allowlist below is forced (via `satisfies`) to cover every valid provider.
 */
type AiProvider = AiEnv["AI_PROVIDER"];

/**
 * The single legitimate location for hardcoded LLM model identifiers (R1.8 / ADR-5).
 *
 * Every other file under `packages/` and `apps/` must derive model IDs from env
 * (via `resolveModel()`), never from literals — the `scripts/forbid-model-ids.sh`
 * grep gate fails the lint stage on any model-ID literal found outside
 * `@vaz/config` and the env schema.
 *
 * Note on the env-schema duplication: `@vaz/schemas/src/env.ts` also carries these
 * defaults as Zod `.default()` values because it is the dependency-graph leaf and
 * cannot import `@vaz/config` (that would invert the `config → schemas` direction).
 * ADR-5 accepts this by exempting both `@vaz/config` and the env schema from the
 * grep gate; keep the two in sync (this file is the canonical allow-list).
 *
 * `readonly [string, ...string[]]` enforces at least one model per provider, so
 * `DEFAULT_MODEL_ID` can safely take the first entry.
 */
export const MODEL_ALLOWLIST = {
	anthropic: ["claude-opus-4-8"],
	ollama: ["llama3.2"],
} as const satisfies Record<AiProvider, readonly [string, ...string[]]>;

/**
 * The default model ID per provider — the first (canonical) entry of each
 * allowlist, so a default is guaranteed to be an allowed value. Mirrors the
 * `.default()` values in `@vaz/schemas/src/env.ts`.
 */
export const DEFAULT_MODEL_ID = {
	anthropic: MODEL_ALLOWLIST.anthropic[0],
	ollama: MODEL_ALLOWLIST.ollama[0],
} as const satisfies Record<AiProvider, string>;
