import { expect, test } from "@playwright/test";

test.describe("home", () => {
	test("チャット UI が表示される", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("heading", { name: "vaz-ai-next" })).toBeVisible();
		await expect(page.getByPlaceholder(/メッセージを入力/)).toBeVisible();
		await expect(page.getByRole("button", { name: "送信" })).toBeVisible();
	});

	test("空入力では送信ボタンが無効", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByRole("button", { name: "送信" })).toBeDisabled();
	});
});

test.describe("/api/chat のリクエスト検証(Zod)", () => {
	test("不正な JSON は 400", async ({ request }) => {
		const res = await request.post("/api/chat", {
			headers: { "content-type": "application/json" },
			data: "{not json",
		});
		expect(res.status()).toBe(400);
	});

	test("スキーマ違反(空 messages)は 400 と issues を返す", async ({ request }) => {
		const res = await request.post("/api/chat", { data: { messages: [] } });
		expect(res.status()).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("Invalid chat request");
		expect(Array.isArray(body.issues)).toBe(true);
	});

	test("role 不正は 400", async ({ request }) => {
		const res = await request.post("/api/chat", {
			data: {
				messages: [{ id: "x", role: "hacker", parts: [{ type: "text", text: "hi" }] }],
			},
		});
		expect(res.status()).toBe(400);
	});
});
