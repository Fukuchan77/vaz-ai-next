import { POST } from "@/app/api/jobs/route";

/**
 * Unit coverage for `POST /api/jobs` (R3.2, R5.1): validates the body against
 * the shared `SupervisorPlan` contract, submits it to the durable engine, and
 * returns `{ jobId }` without waiting for execution. The engine module and
 * `@/lib/auth` are mocked so this exercises only the HTTP⇔engine adapter — no
 * Inngest SDK, no real NextAuth, no network, symmetric with
 * `chat-route.spec.ts`. `JobRequest.userId` (Task 18.3) is resolved from the
 * Auth.js session via `auth()`/`toRuntimeContext()`.
 */

const { createInngestEngine, submitJob } = vi.hoisted(() => ({
	createInngestEngine: vi.fn(),
	submitJob: vi.fn(),
}));
const { authMock, toRuntimeContextMock } = vi.hoisted(() => ({
	authMock: vi.fn(),
	toRuntimeContextMock: vi.fn(),
}));

vi.mock("@vaz/worker/src/inngest", () => ({ createInngestEngine }));
vi.mock("@vaz/worker/src/main", () => ({ submitJob }));
vi.mock("@/lib/auth", () => ({ auth: authMock, toRuntimeContext: toRuntimeContextMock }));

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/api/jobs", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

const validBody = {
	goal: "research and summarize",
	steps: [
		{
			stepId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
			task: { kind: "rag-research", query: "vaz architecture" },
		},
	],
};

const fakeEngine = { createFunction: vi.fn(), send: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	createInngestEngine.mockResolvedValue(fakeEngine);
	submitJob.mockResolvedValue(undefined);
	// Unauthenticated by default; individual tests override for a signed-in session.
	authMock.mockResolvedValue(null);
	toRuntimeContextMock.mockReturnValue({ userId: null, role: null });
});

test("submits the validated plan to the engine and returns a generated jobId", async () => {
	const res = await POST(jsonRequest(validBody));

	expect(res.status).toBe(202);
	const { jobId } = await res.json();
	expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	expect(createInngestEngine).toHaveBeenCalledTimes(1);
	expect(submitJob).toHaveBeenCalledWith(fakeEngine, {
		jobId,
		userId: null,
		plan: validBody,
	});
});

test("submits the plan with the authenticated user's id (R5.1, Task 18.3)", async () => {
	const session = { user: { id: "user_123", role: "member" } };
	authMock.mockResolvedValue(session);
	toRuntimeContextMock.mockReturnValue({ userId: "user_123", role: "member" });

	const res = await POST(jsonRequest(validBody));

	expect(res.status).toBe(202);
	const { jobId } = await res.json();
	expect(toRuntimeContextMock).toHaveBeenCalledWith(session);
	expect(submitJob).toHaveBeenCalledWith(fakeEngine, {
		jobId,
		userId: "user_123",
		plan: validBody,
	});
});

test("returns 400 for a malformed JSON body (never reaches the engine)", async () => {
	const res = await POST(
		new Request("http://localhost/api/jobs", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{ not json",
		}),
	);

	expect(res.status).toBe(400);
	expect(submitJob).not.toHaveBeenCalled();
});

test("returns 400 when the request fails schema validation (empty steps)", async () => {
	const res = await POST(jsonRequest({ goal: "x", steps: [] }));

	expect(res.status).toBe(400);
	expect(submitJob).not.toHaveBeenCalled();
});

describe("Idempotency-Key header (adversarial-review fix)", () => {
	const key = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

	test("uses the client-supplied Idempotency-Key as the jobId", async () => {
		const res = await POST(jsonRequest(validBody, { "Idempotency-Key": key }));

		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ jobId: key });
		expect(submitJob).toHaveBeenCalledWith(fakeEngine, {
			jobId: key,
			userId: null,
			plan: validBody,
		});
	});

	test("two submissions with the same Idempotency-Key produce the same jobId", async () => {
		const first = await POST(jsonRequest(validBody, { "Idempotency-Key": key }));
		const second = await POST(jsonRequest(validBody, { "Idempotency-Key": key }));

		expect((await first.json()).jobId).toBe((await second.json()).jobId);
	});

	test("returns 400 for a malformed Idempotency-Key header (never reaches the engine)", async () => {
		const res = await POST(jsonRequest(validBody, { "Idempotency-Key": "not-a-uuid" }));

		expect(res.status).toBe(400);
		expect(submitJob).not.toHaveBeenCalled();
	});

	test("falls back to a generated jobId when the header is absent", async () => {
		const res = await POST(jsonRequest(validBody));

		const { jobId } = await res.json();
		expect(jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});
});

test("returns 500 (not an unhandled throw) when engine submission fails", async () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	submitJob.mockRejectedValue(new Error("engine unavailable"));

	const res = await POST(jsonRequest(validBody));

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ error: "Failed to submit job" });
	errorSpy.mockRestore();
});
