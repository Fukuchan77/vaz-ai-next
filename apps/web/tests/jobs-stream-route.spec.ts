import { GET } from "@/app/api/jobs/[id]/stream/route";

/**
 * Unit coverage for `GET /api/jobs/:id/stream` (R3.6): subscribes to the job's
 * Redis pub/sub channel (`job:<jobId>`, `@vaz/worker/src/publisher`'s
 * `jobChannel`) and forwards each published `JobEvent` to the browser as an
 * SSE `data:` frame. The `redis` client is mocked so this exercises only the
 * subscribe⇔SSE adapter — no real Redis, no network.
 *
 * Task 21.4 / adversarial-review fix: authorization + `jobId` uuid validation
 * are delegated to `@/lib/jobs`'s `authorizeJobAccess` (400/401/404/403),
 * unit-tested on its own in `jobs.spec.ts` — same contract as
 * `jobs-approve-route.spec.ts`. Here it's mocked directly; the default in
 * `beforeEach` is a granted owner-match so the pre-existing behavioral tests
 * below are unaffected.
 */

const { createClient, authorizeJobAccess } = vi.hoisted(() => ({
	createClient: vi.fn(),
	authorizeJobAccess: vi.fn(),
}));
vi.mock("redis", () => ({ createClient }));
vi.mock("@/lib/jobs", () => ({ authorizeJobAccess }));

interface FakeRedisClient {
	on: ReturnType<typeof vi.fn>;
	connect: ReturnType<typeof vi.fn>;
	subscribe: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	quit: ReturnType<typeof vi.fn>;
	emit(message: string): void;
}

function makeFakeClient(): FakeRedisClient {
	let handler: ((message: string) => void) | undefined;
	return {
		on: vi.fn(),
		connect: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn(async (_channel: string, listener: (message: string) => void) => {
			handler = listener;
		}),
		unsubscribe: vi.fn().mockResolvedValue(undefined),
		quit: vi.fn().mockResolvedValue(undefined),
		emit(message) {
			handler?.(message);
		},
	};
}

const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ownerUserId = "user-1";

function streamRequest(id: string = jobId): Request {
	return new Request(`http://localhost/api/jobs/${id}/stream`);
}

function callGet(id: string = jobId) {
	return GET(streamRequest(id), { params: Promise.resolve({ id }) });
}

function getReader(res: Response): ReadableStreamDefaultReader<Uint8Array> {
	if (!res.body) throw new Error("expected a response body");
	return res.body.getReader();
}

beforeEach(() => {
	vi.clearAllMocks();
	authorizeJobAccess.mockResolvedValue({ ok: true, callerId: ownerUserId });
});

describe("authorization + validation (R5.1, Task 21.4)", () => {
	test("returns whatever authorizeJobAccess denies with (e.g. 400 for a non-uuid job id, never touches redis)", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Invalid job id" }, { status: 400 }),
		});

		const res = await callGet("not-a-uuid");

		expect(res.status).toBe(400);
		expect(createClient).not.toHaveBeenCalled();
	});

	test("returns 401 when there is no authenticated session", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Unauthorized" }, { status: 401 }),
		});

		const res = await callGet();

		expect(res.status).toBe(401);
		expect(createClient).not.toHaveBeenCalled();
	});

	test("returns 404 when the job has no row yet", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Job not found" }, { status: 404 }),
		});

		const res = await callGet();

		expect(res.status).toBe(404);
		expect(createClient).not.toHaveBeenCalled();
	});

	test("returns 403 when the caller does not own the job", async () => {
		authorizeJobAccess.mockResolvedValue({
			ok: false,
			response: Response.json({ error: "Forbidden" }, { status: 403 }),
		});

		const res = await callGet();

		expect(res.status).toBe(403);
		expect(createClient).not.toHaveBeenCalled();
	});

	test("proceeds when authorizeJobAccess grants (e.g. anonymous-submission bypass)", async () => {
		authorizeJobAccess.mockResolvedValue({ ok: true, callerId: "someone-else" });
		createClient.mockReturnValue(makeFakeClient());

		const res = await callGet();

		expect(res.status).toBe(200);
	});
});

test("subscribes to the job's redis channel and streams published events as SSE frames", async () => {
	const fakeClient = makeFakeClient();
	createClient.mockReturnValue(fakeClient);

	const res = await GET(streamRequest(), { params: Promise.resolve({ id: jobId }) });

	expect(res.headers.get("content-type")).toBe("text/event-stream");
	await vi.waitFor(() => expect(fakeClient.subscribe).toHaveBeenCalledTimes(1));
	expect(fakeClient.subscribe.mock.calls[0]?.[0]).toBe(`job:${jobId}`);

	const event = {
		jobId,
		ts: "2026-01-01T00:00:00.000Z",
		type: "step-start",
		stepId: jobId,
		kind: "rag-research",
	};
	fakeClient.emit(JSON.stringify(event));

	const { value } = await getReader(res).read();
	expect(new TextDecoder().decode(value)).toBe(`data: ${JSON.stringify(event)}\n\n`);
});

test("unsubscribes and closes the redis client when the browser disconnects", async () => {
	const fakeClient = makeFakeClient();
	createClient.mockReturnValue(fakeClient);

	const res = await GET(streamRequest(), { params: Promise.resolve({ id: jobId }) });
	await vi.waitFor(() => expect(fakeClient.subscribe).toHaveBeenCalledTimes(1));

	await res.body?.cancel();

	expect(fakeClient.unsubscribe).toHaveBeenCalledWith(`job:${jobId}`);
	expect(fakeClient.quit).toHaveBeenCalledTimes(1);
});

test("propagates a redis connect failure to the stream consumer", async () => {
	const fakeClient = makeFakeClient();
	fakeClient.connect.mockRejectedValue(new Error("redis unavailable"));
	createClient.mockReturnValue(fakeClient);

	const res = await GET(streamRequest(), { params: Promise.resolve({ id: jobId }) });

	await expect(getReader(res).read()).rejects.toThrow("redis unavailable");
});

test("closes the redis client when subscribe fails after connect succeeds", async () => {
	const fakeClient = makeFakeClient();
	fakeClient.subscribe.mockRejectedValue(new Error("subscribe failed"));
	createClient.mockReturnValue(fakeClient);

	const res = await GET(streamRequest(), { params: Promise.resolve({ id: jobId }) });

	await expect(getReader(res).read()).rejects.toThrow("subscribe failed");
	await vi.waitFor(() => expect(fakeClient.quit).toHaveBeenCalledTimes(1));
	expect(fakeClient.unsubscribe).toHaveBeenCalledWith(`job:${jobId}`);
});

test("closes the stream and the redis client on a job-level terminal event", async () => {
	const fakeClient = makeFakeClient();
	createClient.mockReturnValue(fakeClient);

	const res = await GET(streamRequest(), { params: Promise.resolve({ id: jobId }) });
	await vi.waitFor(() => expect(fakeClient.subscribe).toHaveBeenCalledTimes(1));

	fakeClient.emit(JSON.stringify({ jobId, ts: "2026-01-01T00:00:05.000Z", type: "completion" }));

	const reader = getReader(res);
	await reader.read(); // the forwarded completion frame
	const { done } = await reader.read();
	expect(done).toBe(true);
	await vi.waitFor(() => expect(fakeClient.quit).toHaveBeenCalledTimes(1));
});

test("does not close the stream on a step-level completion (stepId set)", async () => {
	const fakeClient = makeFakeClient();
	createClient.mockReturnValue(fakeClient);

	const res = await GET(streamRequest(), { params: Promise.resolve({ id: jobId }) });
	await vi.waitFor(() => expect(fakeClient.subscribe).toHaveBeenCalledTimes(1));

	fakeClient.emit(
		JSON.stringify({
			jobId,
			ts: "2026-01-01T00:00:05.000Z",
			type: "completion",
			stepId: jobId,
			result: { kind: "data-processing", result: "ok" },
		}),
	);

	await getReader(res).read();
	expect(fakeClient.quit).not.toHaveBeenCalled();
});
