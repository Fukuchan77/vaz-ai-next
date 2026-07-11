import { POST } from "@/app/api/chat/route";

/**
 * Unit coverage for the `/api/chat` route's error handling and auth wiring
 * (R5.1). The agent core and `@/lib/auth` are mocked so we exercise
 * the HTTP adapter in isolation (no model / no network / no real NextAuth):
 * a stream-construction failure must surface as a 500 JSON body rather than an
 * unhandled rejection, symmetric with the 400s the route already returns; and
 * the route must call `auth()`/`toRuntimeContext()` and forward the result
 * into the agent's `deps.runtimeContext`.
 */

const { createChatAgent } = vi.hoisted(() => ({
	createChatAgent: vi.fn(),
}));
const { authMock, toRuntimeContextMock } = vi.hoisted(() => ({
	authMock: vi.fn(),
	toRuntimeContextMock: vi.fn(),
}));

vi.mock("@vaz/agents/index", () => ({ createChatAgent }));
vi.mock("@/lib/auth", () => ({ auth: authMock, toRuntimeContext: toRuntimeContextMock }));

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
	// Unauthenticated by default; individual tests override for a signed-in session.
	authMock.mockResolvedValue(null);
	toRuntimeContextMock.mockReturnValue({ userId: null, role: null });
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

test("wires the authenticated session's runtimeContext into the agent's deps (R5.1)", async () => {
	const session = { user: { id: "user_123", role: "admin" } };
	authMock.mockResolvedValue(session);
	toRuntimeContextMock.mockReturnValue({ userId: "user_123", role: "admin" });
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	createChatAgent.mockReturnValue({ stream: () => Promise.reject(new Error("boom")) });

	await POST(jsonRequest(validBody));

	expect(toRuntimeContextMock).toHaveBeenCalledWith(session);
	expect(createChatAgent).toHaveBeenCalledWith(
		expect.objectContaining({ runtimeContext: { userId: "user_123", role: "admin" } }),
	);
	errorSpy.mockRestore();
});

test("wires a null userId/role into deps.runtimeContext when unauthenticated (R5.1)", async () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	createChatAgent.mockReturnValue({ stream: () => Promise.reject(new Error("boom")) });

	await POST(jsonRequest(validBody));

	expect(toRuntimeContextMock).toHaveBeenCalledWith(null);
	expect(createChatAgent).toHaveBeenCalledWith(
		expect.objectContaining({ runtimeContext: { userId: null, role: null } }),
	);
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
