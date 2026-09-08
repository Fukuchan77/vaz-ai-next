import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * X-14b: accessibility E2E. `apps/web` is built on the Carbon Design System
 * (`@carbon/react`), which ships accessible primitives out of the box, but
 * nothing in this repo verified that — this spec is the first a11y coverage
 * here. Scans the home page's default (empty) state and, separately, the
 * error-notification state (`InlineNotification`, a Carbon component easy to
 * misuse in a way that drops its accessible name/role) against the WCAG 2.1
 * A/AA rule set. Modeled on
 * `beeai-agentic-ai-sandbox/apps/frontend/tests/e2e/09-accessibility.spec.ts`
 * (docs/cross-repo-adoption-backlog.md, X-14b).
 */
test.describe("accessibility (WCAG 2.1 A/AA)", () => {
	test("home page has no detectable a11y violations", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "vaz-ai-next" })).toBeVisible();

		const results = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();

		expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
	});

	test("the chat error state has no detectable a11y violations", async ({ page }) => {
		// Force the useChat() transport to fail so `InlineNotification` renders
		// (Chat.tsx renders it only when `error` is set) without depending on a
		// real model/network.
		await page.route("**/api/chat", (route) => route.fulfill({ status: 500, body: "" }));

		await page.goto("/");
		await page.getByPlaceholder(/メッセージを入力/).fill("trigger an error");
		await page.getByRole("button", { name: "送信" }).click();
		// Carbon's `InlineNotification` defaults to role="status" (not "alert").
		await expect(page.getByRole("status")).toBeVisible();

		const results = await new AxeBuilder({ page })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();

		expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
	});
});
