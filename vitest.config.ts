import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@": new URL("./src", import.meta.url).pathname,
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./tests/setupTests.ts"],
		globals: true,
		include: ["tests/**/*.spec.{ts,tsx}"],
		exclude: ["tests/e2e/**", "node_modules/**"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// App Router のエントリ(layout/page/route)は E2E で検証するため除外
			exclude: ["src/app/**"],
			thresholds: { lines: 80, functions: 80 },
		},
	},
});
