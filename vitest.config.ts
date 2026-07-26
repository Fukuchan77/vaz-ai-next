import { defineConfig } from "vitest/config";

/**
 * Root Vitest **projects** aggregator (R1.9/NFR-1). `mise run test:run`
 * (`vitest run`) executes every project below across the workspace:
 *
 * - `web`      — jsdom, `apps/web` (self-contained, see apps/web/vitest.config.ts).
 * - `worker`   — node, `apps/worker` (self-contained, see apps/worker/vitest.config.ts);
 *                engine-agnostic worker-entry wiring tested with injected seams.
 * - `packages` — node, `@vaz/*` unit tests (e.g. @vaz/agents MockLanguageModelV4).
 *                Also matches each package's `src/unit/` subtree: `@vaz/evals`
 *                keeps its tier1 MockModel specs there, not the `tests/**`
 *                convention the other four packages use.
 *
 * Coverage is configured once here so it aggregates across projects. Since
 * Vitest 4 (which removed `coverage.all` and only reports files loaded during
 * the run) it deliberately measures the whole workspace — `apps/*` and
 * `packages/*` — with unit-untestable entry points excluded below (App Router
 * entries and process/CLI mains are E2E / ops territory).
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
					include: [
						"packages/*/tests/**/*.spec.{ts,tsx}",
						"packages/*/src/unit/**/*.spec.{ts,tsx}",
					],
					exclude: ["**/node_modules/**"],
				},
			},
		],
		coverage: {
			provider: "v8",
			include: ["apps/web/src/**", "apps/worker/src/**", "packages/*/src/**"],
			exclude: [
				// App Router entries (layout/page/route) are verified by E2E.
				"apps/web/src/app/**",
				// Stylesheets are not coverage targets (pulled in by component imports).
				"**/*.scss",
				// Pure barrels (re-exports only, no executable code).
				"packages/tools/src/index.ts",
				// Process entry (composition root) — start-time dynamic-import wiring only.
				"apps/worker/src/start.ts",
				// Migration CLI composition root — pure parts are exported and unit-tested
				// in packages/db/tests/migrate.spec.ts; the transactional apply loop is an
				// I/O boundary verified against a reachable PostgreSQL (R2.3).
				"packages/db/bin/migrate.ts",
				// Nightly eval CLI runner — operational script run by the eval-nightly workflow.
				"packages/evals/src/nightly.ts",
				// PR-gate eval CLI runner — operational script run by the eval-pr workflow.
				"packages/evals/src/pr-gate.ts",
			],
			thresholds: { lines: 80, functions: 80 },
		},
	},
});
