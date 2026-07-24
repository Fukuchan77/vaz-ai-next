import { expect, test } from "@playwright/test";

/**
 * End-to-end chat round-trip against Anthropic — the sibling of
 * `chat-ollama.spec.ts`. Together they verify that the env-driven provider
 * switch (`@vaz/config#resolveModel`) is equivalent end-to-end on *both*
 * providers after the monorepo migration (R1.10 / NFR-5).
 *
 * Run conditions (auto-skipped when unmet, so default `mise run test:e2e`
 * without secrets stays green):
 * - The server is started with `AI_PROVIDER=anthropic` (the default provider)
 * - `ANTHROPIC_API_KEY` is present (never committed; supplied via env/CI secret)
 *
 * Example: `ANTHROPIC_API_KEY=… mise run test:e2e`
 */
test.describe("chat via Anthropic (cloud LLM)", () => {
	test.skip(
		process.env.AI_PROVIDER === "ollama" || !process.env.ANTHROPIC_API_KEY,
		"runs only when AI_PROVIDER=anthropic and ANTHROPIC_API_KEY is set",
	);

	test("round-trips a message with Anthropic", async ({ page }) => {
		test.setTimeout(120_000);

		await page.goto("/");
		await page
			.getByPlaceholder(/メッセージを入力/)
			.fill("Reply with exactly the single word: pong");
		await page.getByRole("button", { name: "送信" }).click();

		// exact: true — a reply containing the substring "You" makes the bare
		// form a strict-mode ambiguous match; only the role label is exactly "You".
		await expect(page.getByText("You", { exact: true })).toBeVisible();

		// Same strict, assistant-scoped assertion as the Ollama spec: the reply must
		// come from the AI bubble, not the echoed prompt.
		const aiTile = page.getByText("AI", { exact: true }).first().locator("xpath=..");
		await expect(aiTile).toBeVisible({ timeout: 90_000 });
		await expect(aiTile.getByText(/pong/i)).toBeVisible({ timeout: 90_000 });
	});
});
