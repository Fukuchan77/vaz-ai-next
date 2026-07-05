import { POST } from "@/app/api/chat/route";

/**
 * Unit coverage for the `/api/chat` route's error handling. The agent core is
 * mocked so we exercise the HTTP adapter in isolation (no model / no network):
 * a stream-construction failure must surface as a 500 JSON body rather than an
 * unhandled rejection, symmetric with the 400s the route already returns.
 */

const { createChatAgent } = vi.hoisted(() => ({
	createChatAgent: vi.fn(),
}));

vi.mock("@vaz/agents/index", () => ({ createChatAgent }));

function jsonRequest(body: unknown): Request {
	return new Request("http://localhost/api/chat", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const validBody = {
	messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
};

beforeEach(() => {
	vi.clearAllMocks();
});

test("returns 500 (not an unhandled throw) when the agent fails to start streaming", async () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	createChatAgent.mockReturnValue({
		stream: () => Promise.reject(new Error("model resolution failed")),
	});

	const res = await POST(jsonRequest(validBody));

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ error: "Failed to process chat request" });
	errorSpy.mockRestore();
});

test("returns 400 for a malformed JSON body (never reaches the agent)", async () => {
	const res = await POST(
		new Request("http://localhost/api/chat", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{ not json",
		}),
	);

	expect(res.status).toBe(400);
	expect(createChatAgent).not.toHaveBeenCalled();
});

test("returns 400 when the request fails schema validation", async () => {
	const res = await POST(jsonRequest({ messages: [] }));

	expect(res.status).toBe(400);
	expect(createChatAgent).not.toHaveBeenCalled();
});
