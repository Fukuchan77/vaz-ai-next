import { expect, test } from "@playwright/test";

test.describe("home", () => {
	test("renders the chat UI", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "vaz-ai-next" })).toBeVisible();
		await expect(page.getByPlaceholder(/メッセージを入力/)).toBeVisible();
		await expect(page.getByRole("button", { name: "送信" })).toBeVisible();
	});

	test("disables the send button on empty input", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
	});
});

test.describe("/api/chat request validation (Zod)", () => {
	test("returns 400 for invalid JSON", async ({ request }) => {
		const res = await request.post("/api/chat", {
			headers: { "content-type": "application/json" },
			data: "{not json",
		});
		expect(res.status()).toBe(400);
	});

	test("returns 400 with issues for a schema violation (empty messages)", async ({ request }) => {
		const res = await request.post("/api/chat", { data: { messages: [] } });
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid chat request");
		expect(Array.isArray(body.issues)).toBe(true);
	});

	test("returns 400 for an invalid role", async ({ request }) => {
		const res = await request.post("/api/chat", {
			data: {
				messages: [{ id: "x", role: "hacker", parts: [{ type: "text", text: "hi" }] }],
			},
		});
		expect(res.status()).toBe(400);
	});
});
