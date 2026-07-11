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
 *                Also matches each package's `src/unit/` subtree (Task 17.2):
 *                `@vaz/evals` keeps its tier1 MockModel specs there per plan.md,
 *                not the `tests/**` convention the other four packages use.
 * - `root-legacy` — jsdom, transitional coverage of the repo-root `tests/**`
 *                specs that still import the root `./src` duplicate. Retired when
 *                the `./src`/`tests` duplication is removed post-Phase 1.
 *
 * Coverage is configured once here so it aggregates across projects. Since
 * Vitest 4 (which removed `coverage.all` and only reports files loaded during
 * the run) it deliberately measures the whole workspace — root `./src`
 * (transitional), `apps/*` and `packages/*` — with unit-untestable entry
 * points excluded below (App Router entries and process/CLI mains are E2E /
 * ops territory).
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
			include: ["src/**", "apps/web/src/**", "apps/worker/src/**", "packages/*/src/**"],
			exclude: [
				// App Router のエントリ(layout/page/route)は E2E で検証するため除外
				"src/app/**",
				"apps/web/src/app/**",
				// スタイルシートはカバレッジの対象外(コンポーネント import で混入する)
				"**/*.scss",
				// 純粋なバレル(再エクスポートのみ、実行可能コードなし)
				"packages/tools/src/index.ts",
				// プロセスエントリ(composition root)— 起動時のみ実行される動的 import 配線
				"apps/worker/src/start.ts",
				// nightly eval の CLI ランナー — eval-nightly ワークフローで実行される運用スクリプト
				"packages/evals/src/nightly.ts",
			],
			thresholds: { lines: 80, functions: 80 },
		},
	},
});
