import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Web (jsdom) Vitest project for `apps/web` (Task 7.1, R1.9/NFR-1).
 *
 * Self-contained and usable standalone (`pnpm --filter @vaz/web exec vitest
 * run`); also referenced by the root `vitest.config.ts` projects aggregator so
 * `mise run test:run` covers the whole workspace. React Compiler is applied via
 * Next only in production builds; here `@vitejs/plugin-react` handles JSX so
 * component tests run without loading `next.config.ts`.
 *
 * NOTE (transition): the UI unit tests currently live at the repo root
 * (`tests/Chat.spec.tsx`) importing the root `./src` duplicate, so this project
 * matches no files yet (`passWithNoTests`). They migrate to `apps/web/tests/**`
 * — together with a local `setupTests.ts` — when the root `./src`/`tests`
 * duplication is retired.
 */
export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": new URL("./src", import.meta.url).pathname,
		},
	},
	test: {
		name: "web",
		environment: "jsdom",
		globals: true,
		include: ["tests/**/*.spec.{ts,tsx}"],
		exclude: ["tests/e2e/**", "node_modules/**"],
		passWithNoTests: true,
	},
});
