import { POST } from "@/app/api/jobs/route";

/**
 * Unit coverage for `POST /api/jobs` (R3.2): validates the body against the
 * shared `SupervisorPlan` contract, submits it to the durable engine, and
 * returns `{ jobId }` without waiting for execution. The engine module is
 * mocked so this exercises only the HTTP⇔engine adapter — no Inngest SDK, no
 * network, symmetric with `chat-route.spec.ts`.
 */

const { createInngestEngine, submitJob } = vi.hoisted(() => ({
	createInngestEngine: vi.fn(),
	submitJob: vi.fn(),
}));

vi.mock("@vaz/worker/src/inngest", () => ({ createInngestEngine }));
vi.mock("@vaz/worker/src/main", () => ({ submitJob }));

function jsonRequest(body: unknown): Request {
	return new Request("http://localhost/api/jobs", {
		method: "POST",
		headers: { "content-type": "application/json" },
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

test("returns 500 (not an unhandled throw) when engine submission fails", async () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	submitJob.mockRejectedValue(new Error("engine unavailable"));

	const res = await POST(jsonRequest(validBody));

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ error: "Failed to submit job" });
	errorSpy.mockRestore();
});
