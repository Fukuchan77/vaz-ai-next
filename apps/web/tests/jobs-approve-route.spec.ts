import { POST } from "@/app/api/jobs/[id]/approve/route";

/**
 * Unit coverage for `POST /api/jobs/:id/approve` (R3.4/3.5): validates the
 * approval decision body against the documented contract
 * (`{ toolCallId, decision, args? }`), then
 * resumes the suspended workflow via `submitApproval` — `toolCallId` carries
 * the plan step's `stepId` (the durable engine's suspend/resume correlation
 * key, `apps/worker/src/main.ts` `ApprovalSignal.stepId`); the approval UI
 * reads it off the `step-start` `JobEvent`. Mocked engine/
 * `submitApproval`, symmetric with `jobs-route.spec.ts` — no Inngest SDK, no
 * network.
 *
 * Adversarial-review fix: authorization is delegated to
 * `@/lib/jobs`'s `authorizeJobAccess` (400/401/404/403), unit-tested on its
 * own in `jobs.spec.ts`. Here it's mocked directly; the default in
 * `beforeEach` is a granted owner-match so the pre-existing behavioral tests
 * below are unaffected — the authorization-focused tests override it per case.
 */

const { createInngestEngine, submitApproval, authorizeJobAccess } = vi.hoisted(() => ({
	createInngestEngine: vi.fn(),
	submitApproval: vi.fn(),
	authorizeJobAccess: vi.fn(),
}));

vi.mock("@vaz/worker/src/inngest", () => ({ createInngestEngine }));
vi.mock("@vaz/worker/src/main", () => ({ submitApproval }));
vi.mock("@/lib/jobs", () => ({ authorizeJobAccess }));

const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const toolCallId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const ownerUserId = "user-1";

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
	authorizeJobAccess.mockResolvedValue({ ok: true, callerId: ownerUserId });
});

describe("authorization (R5.1)", () => {
	test("returns whatever authorizeJobAccess denies with (e.g. 401 with no session)", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Unauthorized" }, { status: 401 }),
		});

		const res = await callPost({ toolCallId, decision: "approve" });

		expect(res.status).toBe(401);
		expect(submitApproval).not.toHaveBeenCalled();
	});

	test("returns 403 when authorizeJobAccess denies ownership", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Forbidden" }, { status: 403 }),
		});

		const res = await callPost({ toolCallId, decision: "approve" });

		expect(res.status).toBe(403);
		expect(submitApproval).not.toHaveBeenCalled();
	});

	test("returns 404 when authorizeJobAccess reports the job has no row yet", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Job not found" }, { status: 404 }),
		});

		const res = await callPost({ toolCallId, decision: "approve" });

		expect(res.status).toBe(404);
		expect(submitApproval).not.toHaveBeenCalled();
	});

	test("proceeds when authorizeJobAccess grants (e.g. anonymous-submission bypass)", async () => {
		authorizeJobAccess.mockResolvedValue({ ok: true, callerId: "someone-else" });

		const res = await callPost({ toolCallId, decision: "approve" });

		expect(res.status).toBe(202);
		expect(submitApproval).toHaveBeenCalledTimes(1);
	});
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
