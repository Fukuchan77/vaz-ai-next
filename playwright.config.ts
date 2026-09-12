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
		// Targets only apps/web (@vaz/web). In CI, starts the production server
		// that `mise run build` (= --filter @vaz/web build) already built.
		command: process.env.CI
			? `pnpm --filter @vaz/web exec next start --port ${PORT}`
			: `pnpm --filter @vaz/web exec next dev --port ${PORT}`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !process.env.CI,
		// Generous timeout to allow for Next.js's initial compilation.
		timeout: 120_000,
		env: {
			// R5.6: hitl-approval.spec.ts asserts that a FORGED tool approval is
			// rejected. That property only exists when the AI SDK has a key to sign
			// approval requests with and verify responses against — without one it
			// skips verification entirely (and `@vaz/agents`' policy then denies
			// approval-capable tools outright, a different code path). Pinning a
			// fixed value here makes the spec deterministic and, crucially, keeps its
			// verdict independent of whether the runner happens to have provider
			// credentials: before this, the assertion passed in CI only because the
			// follow-up model call failed for lack of an API key.
			//
			// Test-only, never a real deployment key: real ones come from
			// TOOL_APPROVAL_SECRET / AUTH_SECRET in the environment.
			TOOL_APPROVAL_SECRET: "e2e-only-tool-approval-signing-key",
		},
	},
});
