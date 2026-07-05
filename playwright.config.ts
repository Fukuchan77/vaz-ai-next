import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.PORT ?? "3000";

export default defineConfig({
	testDir: "./apps/web/tests/e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: "html",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
		},
	],
	webServer: {
		// apps/web(@vaz/web)のみを対象に起動する(モノレポ化後, Task 7.2)。
		// CI では事前に `mise run build`(= --filter @vaz/web build)済みの本番サーバーを起動する。
		command: process.env.CI
			? `pnpm --filter @vaz/web exec next start --port ${PORT}`
			: `pnpm --filter @vaz/web exec next dev --port ${PORT}`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !process.env.CI,
		// Next.js の初回コンパイルを考慮して余裕を持たせる
		timeout: 120_000,
	},
});
