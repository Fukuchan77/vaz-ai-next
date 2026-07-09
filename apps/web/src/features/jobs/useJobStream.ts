"use client";

import { type JobEvent, jobEventSchema } from "@vaz/schemas/workflows";
import { parseJsonEventStream } from "ai";
import { useEffect, useState } from "react";

export type JobStreamStatus = "connecting" | "open" | "closed" | "error";

export interface UseJobStreamResult {
	events: JobEvent[];
	latestEvent: JobEvent | null;
	status: JobStreamStatus;
	error: Error | null;
}

/**
 * `useJobStream(jobId)` — client hook consuming `GET /api/jobs/:id/stream`
 * (Task 14.2) and accumulating the typed `JobEvent` discriminated union
 * (R3.6).
 *
 * Reuses the AI SDK's `parseJsonEventStream` (`ai` → `@ai-sdk/provider-utils`,
 * already a project dependency) to parse the `data: <json>\n\n` SSE frames
 * against `jobEventSchema` instead of a bespoke SSE parser — the same
 * reuse-over-reinvent precedent as 14.1-14.3 (`@vaz/worker` engine/publisher
 * reuse). `fetch` + `getReader()` is used rather than `EventSource`, since
 * `parseJsonEventStream` operates on a `ReadableStream<Uint8Array>`
 * (`Response.body`), which `EventSource` does not expose.
 *
 * A frame that fails `jobEventSchema` is dropped and logged, not surfaced via
 * `error` — mirrors the worker-side sink's drop-and-log contract
 * (`apps/worker/src/events.ts`, 13.3): one malformed frame must not tear down
 * the subscription other events are still arriving on.
 */
export function useJobStream(jobId: string | null | undefined): UseJobStreamResult {
	const [events, setEvents] = useState<JobEvent[]>([]);
	const [status, setStatus] = useState<JobStreamStatus>(jobId ? "connecting" : "closed");
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		if (!jobId) {
			setEvents([]);
			setStatus("closed");
			setError(null);
			return;
		}

		setEvents([]);
		setStatus("connecting");
		setError(null);

		const controller = new AbortController();
		let cancelled = false;

		async function consume() {
			try {
				const response = await fetch(`/api/jobs/${jobId}/stream`, {
					signal: controller.signal,
				});
				if (cancelled) return;
				if (!response.ok || !response.body) {
					throw new Error(`Job stream request failed with status ${response.status}`);
				}
				setStatus("open");

				const reader = parseJsonEventStream({
					stream: response.body,
					schema: jobEventSchema,
				}).getReader();

				while (true) {
					const { done, value } = await reader.read();
					if (cancelled) return;
					if (done) break;
					if (value.success) {
						setEvents((prev) => [...prev, value.value]);
					} else {
						console.error("Dropped malformed job event frame", value.error);
					}
				}
				setStatus("closed");
			} catch (caught) {
				if (cancelled) return;
				setStatus("error");
				setError(caught instanceof Error ? caught : new Error(String(caught)));
			}
		}

		void consume();

		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [jobId]);

	return {
		events,
		latestEvent: events.at(-1) ?? null,
		status,
		error,
	};
}
