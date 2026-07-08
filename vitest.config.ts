import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Root Vitest **projects** aggregator (Task 7.1, R1.9/NFR-1). `mise run
 * test:run` (`vitest run`) executes every project below across the workspace:
 *
 * - `web`      — jsdom, `apps/web` (self-contained, see apps/web/vitest.config.ts).
 * - `worker`   — node, `apps/worker` (self-contained, see apps/worker/vitest.config.ts);
 *                engine-agnostic worker-entry wiring tested with injected seams.
 * - `packages` — node, `@vaz/*` unit tests (e.g. @vaz/agents MockLanguageModelV4,
 *                which the previous single-config `include: tests/**` missed).
 * - `root-legacy` — jsdom, transitional coverage of the repo-root `tests/**`
 *                specs that still import the root `./src` duplicate. Retired when
 *                the `./src`/`tests` duplication is removed post-Phase 1.
 *
 * Coverage is configured once here so it aggregates across projects; it targets
 * the transitional root `./src` (App Router entries validated by E2E only).
 */
export default defineConfig({
	test: {
		projects: [
			"./apps/web/vitest.config.ts",
			"./apps/worker/vitest.config.ts",
			{
				test: {
					name: "packages",
					environment: "node",
					globals: true,
					include: ["packages/*/tests/**/*.spec.{ts,tsx}"],
					exclude: ["**/node_modules/**"],
				},
			},
			{
				plugins: [react()],
				resolve: {
					alias: {
						"@": new URL("./src", import.meta.url).pathname,
					},
				},
				test: {
					name: "root-legacy",
					environment: "jsdom",
					globals: true,
					setupFiles: ["./tests/setupTests.ts"],
					include: ["tests/**/*.spec.{ts,tsx}"],
					exclude: ["tests/e2e/**", "node_modules/**"],
				},
			},
		],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// App Router のエントリ(layout/page/route)は E2E で検証するため除外
			exclude: ["src/app/**"],
			thresholds: { lines: 80, functions: 80 },
		},
	},
});
