import { expect, test } from "@playwright/test";

/**
 * End-to-end chat round-trip against a local LLM (Ollama).
 *
 * Run conditions (auto-skipped when unmet):
 * - The server is started with `AI_PROVIDER=ollama`
 * - Ollama responds at OLLAMA_BASE_URL (default http://localhost:11434/v1)
 *
 * Example: `AI_PROVIDER=ollama pnpm test:e2e` / `mise run test:e2e:ollama`
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

async function ollamaIsReachable(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_BASE_URL}/models`, {
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

test.describe("chat via Ollama (local LLM)", () => {
	test.skip(process.env.AI_PROVIDER !== "ollama", "AI_PROVIDER=ollama が設定されたときのみ実行");

	test("ローカル LLM とメッセージを往復できる", async ({ page }) => {
		test.skip(!(await ollamaIsReachable()), `Ollama が応答しない: ${OLLAMA_BASE_URL}`);
		test.setTimeout(180_000);

		await page.goto("/");
		await page
			.getByPlaceholder(/メッセージを入力/)
			.fill("Reply with exactly the single word: pong");
		await page.getByRole("button", { name: "送信" }).click();

		// Both the user message and the AI response appear (allow extra time for local inference).
		await expect(page.getByText("You")).toBeVisible();
		await expect(page.getByText(/pong/i).last()).toBeVisible({ timeout: 150_000 });
	});
});
