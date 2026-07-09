import { POST } from "@/app/api/jobs/[id]/approve/route";

/**
 * Unit coverage for `POST /api/jobs/:id/approve` (R3.4/3.5): validates the
 * approval decision body against the documented contract
 * (`{ toolCallId, decision, args? }`, plan.md Interfaces/Contracts), then
 * resumes the suspended workflow via `submitApproval` — `toolCallId` carries
 * the plan step's `stepId` (the durable engine's suspend/resume correlation
 * key, `apps/worker/src/main.ts` `ApprovalSignal.stepId`); the approval UI
 * (Task 14.5) reads it off the `step-start` `JobEvent`. Mocked engine/
 * `submitApproval`, symmetric with `jobs-route.spec.ts` — no Inngest SDK, no
 * network.
 */

const { createInngestEngine, submitApproval } = vi.hoisted(() => ({
	createInngestEngine: vi.fn(),
	submitApproval: vi.fn(),
}));

vi.mock("@vaz/worker/src/inngest", () => ({ createInngestEngine }));
vi.mock("@vaz/worker/src/main", () => ({ submitApproval }));

const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const toolCallId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

function approveRequest(body: unknown): Request {
	return new Request(`http://localhost/api/jobs/${jobId}/approve`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function callPost(body: unknown) {
	return POST(approveRequest(body), { params: Promise.resolve({ id: jobId }) });
}

const fakeEngine = { createFunction: vi.fn(), send: vi.fn() };

beforeEach(() => {
	vi.clearAllMocks();
	createInngestEngine.mockResolvedValue(fakeEngine);
	submitApproval.mockResolvedValue(undefined);
});

test("resumes an approved step via submitApproval and returns 202", async () => {
	const res = await callPost({ toolCallId, decision: "approve", args: { to: "user@example.com" } });

	expect(res.status).toBe(202);
	expect(await res.json()).toEqual({ ok: true });
	expect(createInngestEngine).toHaveBeenCalledTimes(1);
	expect(submitApproval).toHaveBeenCalledWith(fakeEngine, {
		jobId,
		stepId: toolCallId,
		approved: true,
		args: { to: "user@example.com" },
	});
});

test("resumes a rejected step with approved:false and no args key when omitted", async () => {
	const res = await callPost({ toolCallId, decision: "reject" });

	expect(res.status).toBe(202);
	expect(submitApproval).toHaveBeenCalledWith(fakeEngine, {
		jobId,
		stepId: toolCallId,
		approved: false,
	});
});

test("returns 400 for a malformed JSON body (never reaches the engine)", async () => {
	const res = await POST(
		new Request(`http://localhost/api/jobs/${jobId}/approve`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{ not json",
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);

	expect(res.status).toBe(400);
	expect(submitApproval).not.toHaveBeenCalled();
});

test("returns 400 when toolCallId is missing", async () => {
	const res = await callPost({ decision: "approve" });

	expect(res.status).toBe(400);
	expect(submitApproval).not.toHaveBeenCalled();
});

test("returns 400 when decision is not approve/reject", async () => {
	const res = await callPost({ toolCallId, decision: "maybe" });

	expect(res.status).toBe(400);
	expect(submitApproval).not.toHaveBeenCalled();
});

test("returns 500 (not an unhandled throw) when engine submission fails", async () => {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	submitApproval.mockRejectedValue(new Error("engine unavailable"));

	const res = await callPost({ toolCallId, decision: "approve" });

	expect(res.status).toBe(500);
	expect(await res.json()).toEqual({ error: "Failed to submit approval" });
	errorSpy.mockRestore();
});
