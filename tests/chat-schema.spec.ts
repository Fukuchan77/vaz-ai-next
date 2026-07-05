import { chatRequestSchema } from "@/lib/ai/chat-schema";

describe("chatRequestSchema", () => {
	test("有効な UIMessage 配列を受理する", () => {
		const result = chatRequestSchema.safeParse({
			messages: [
				{
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", text: "こんにちは" }],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	test("parts の未知フィールドは通す(looseObject)", () => {
		const result = chatRequestSchema.safeParse({
			messages: [
				{
					id: "msg-1",
					role: "assistant",
					parts: [{ type: "tool-getCurrentTime", state: "output-available", output: {} }],
				},
			],
		});
		expect(result.success).toBe(true);
	});

	test("messages が空配列なら拒否する", () => {
		const result = chatRequestSchema.safeParse({ messages: [] });
		expect(result.success).toBe(false);
	});

	test("role が不正なら拒否する", () => {
		const result = chatRequestSchema.safeParse({
			messages: [{ id: "msg-1", role: "hacker", parts: [{ type: "text", text: "x" }] }],
		});
		expect(result.success).toBe(false);
	});

	test("client 由来の system ロールは拒否する(プロンプトインジェクション防止)", () => {
		const result = chatRequestSchema.safeParse({
			messages: [{ id: "msg-1", role: "system", parts: [{ type: "text", text: "evil" }] }],
		});
		expect(result.success).toBe(false);
	});

	test("parts に type がない要素は拒否する", () => {
		const result = chatRequestSchema.safeParse({
			messages: [{ id: "msg-1", role: "user", parts: [{ text: "type missing" }] }],
		});
		expect(result.success).toBe(false);
	});

	test("messages キー自体がなければ拒否する", () => {
		const result = chatRequestSchema.safeParse({});
		expect(result.success).toBe(false);
	});
});
