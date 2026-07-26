import { expect, test } from "@playwright/test";

/**
 * End-to-end chat round-trip against a local LLM (Ollama).
 *
 * Run conditions (auto-skipped when unmet):
 * - The server is started with `AI_PROVIDER=ollama`
 * - Ollama responds at OLLAMA_BASE_URL AND the target model is actually pulled
 *
 * Example: `AI_PROVIDER=ollama pnpm test:e2e` / `mise run test:e2e:ollama`
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

/**
 * True only when Ollama is reachable AND the target model is pulled. Checking
 * model availability (not just endpoint reachability) is what keeps this test
 * honest: if the model is missing the server returns "model not found", so we
 * skip rather than run a round-trip that can only fail.
 */
async function ollamaModelAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_BASE_URL}/models`, { signal: AbortSignal.timeout(2_000) });
		if (!res.ok) {
			return false;
		}
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
		// Ollama reports models as `name:tag` (e.g. llama3.2:latest); match the base name.
		const base = OLLAMA_MODEL.split(":")[0];
		return ids.some((id) => id === OLLAMA_MODEL || id.split(":")[0] === base);
	} catch {
		return false;
	}
}

test.describe("chat via Ollama (local LLM)", () => {
	test.skip(process.env.AI_PROVIDER !== "ollama", "runs only when AI_PROVIDER=ollama");

	test("round-trips a message with the local LLM", async ({ page }) => {
		test.skip(
			!(await ollamaModelAvailable()),
			`${OLLAMA_MODEL} unavailable on Ollama (not started or not pulled): ${OLLAMA_BASE_URL}`,
		);
		test.setTimeout(180_000);

		await page.goto("/");
		await page
			.getByPlaceholder(/メッセージを入力/)
			.fill("Reply with exactly the single word: pong");
		await page.getByRole("button", { name: "送信" }).click();

		// The user's own message bubble appears immediately (optimistic UI).
		// exact: true — a reply containing the substring "You" makes the bare
		// form a strict-mode ambiguous match; only the role label is exactly "You".
		await expect(page.getByText("You", { exact: true })).toBeVisible();

		// Strict round-trip assertion: an assistant ("AI") bubble must appear and
		// *its* text must contain the reply. Scoping to the assistant tile is
		// essential — the user's prompt also contains "pong", so a page-wide match
		// would pass even when the model errors (the false-green this replaces).
		const aiTile = page.getByText("AI", { exact: true }).first().locator("xpath=..");
		await expect(aiTile).toBeVisible({ timeout: 150_000 });
		await expect(aiTile.getByText(/pong/i)).toBeVisible({ timeout: 150_000 });
	});
});
