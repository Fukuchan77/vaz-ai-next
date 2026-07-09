import { act, renderHook, waitFor } from "@testing-library/react";
import { useJobStream } from "@/features/jobs/useJobStream";

/**
 * Unit coverage for `useJobStream` (Task 14.4, R3.6): consumes
 * `GET /api/jobs/:id/stream` (14.2) and accumulates the typed `JobEvent`
 * discriminated union. `fetch` is mocked to return a controlled SSE byte
 * stream so this exercises only the client-side consume⇔accumulate contract —
 * no real network, no real Route Handler.
 */

const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let index = 0;
	return new ReadableStream({
		pull(controller) {
			if (index < frames.length) {
				controller.enqueue(encoder.encode(frames[index]));
				index += 1;
			} else {
				controller.close();
			}
		},
	});
}

function sseFrame(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const stepStartEvent = {
	jobId,
	ts: "2026-01-01T00:00:00.000Z",
	type: "step-start",
	stepId: jobId,
	kind: "rag-research",
};

const completionEvent = {
	jobId,
	ts: "2026-01-01T00:00:05.000Z",
	type: "completion",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

test("does not fetch and stays closed when jobId is null", () => {
	const { result } = renderHook(() => useJobStream(null));

	expect(fetchMock).not.toHaveBeenCalled();
	expect(result.current).toEqual({ events: [], latestEvent: null, status: "closed", error: null });
});

test("streams and accumulates valid job events until the response body closes", async () => {
	fetchMock.mockResolvedValue(
		new Response(sseStream([sseFrame(stepStartEvent), sseFrame(completionEvent)]), {
			status: 200,
		}),
	);

	const { result } = renderHook(() => useJobStream(jobId));

	expect(fetchMock).toHaveBeenCalledWith(
		`/api/jobs/${jobId}/stream`,
		expect.objectContaining({ signal: expect.any(AbortSignal) }),
	);

	await waitFor(() => expect(result.current.status).toBe("closed"));
	expect(result.current.events).toEqual([stepStartEvent, completionEvent]);
	expect(result.current.latestEvent).toEqual(completionEvent);
});

test("drops a malformed event frame without surfacing it as an error", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	fetchMock.mockResolvedValue(
		new Response(sseStream([sseFrame({ type: "not-a-real-type" }), sseFrame(stepStartEvent)]), {
			status: 200,
		}),
	);

	const { result } = renderHook(() => useJobStream(jobId));

	await waitFor(() => expect(result.current.status).toBe("closed"));
	expect(result.current.events).toEqual([stepStartEvent]);
	expect(result.current.error).toBeNull();
	expect(consoleError).toHaveBeenCalled();

	consoleError.mockRestore();
});

test("surfaces a fetch rejection as an error status", async () => {
	fetchMock.mockRejectedValue(new Error("network down"));

	const { result } = renderHook(() => useJobStream(jobId));

	await waitFor(() => expect(result.current.status).toBe("error"));
	expect(result.current.error).toBeInstanceOf(Error);
	expect(result.current.error?.message).toBe("network down");
});

test("surfaces a non-ok response as an error status", async () => {
	fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

	const { result } = renderHook(() => useJobStream(jobId));

	await waitFor(() => expect(result.current.status).toBe("error"));
	expect(result.current.error).toBeInstanceOf(Error);
});

test("aborts the in-flight request on unmount", async () => {
	fetchMock.mockResolvedValue(new Response(sseStream([]), { status: 200 }));

	const { unmount } = renderHook(() => useJobStream(jobId));

	await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
	const signal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
	expect(signal.aborted).toBe(false);

	act(() => {
		unmount();
	});

	expect(signal.aborted).toBe(true);
});
