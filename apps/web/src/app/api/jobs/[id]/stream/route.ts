import { jobChannel } from "@vaz/worker/src/publisher";
import { createClient } from "redis";

/**
 * `GET /api/jobs/:id/stream` — SSE Route Handler streaming a job's `JobEvent`
 * discriminated union to the browser (R3.6).
 *
 * The worker-side sink (`apps/worker/src/events.ts`, Task 13.3/13.8) publishes
 * each validated event to a per-job Redis channel via
 * `createJobEventPublisher` (`apps/worker/src/publisher.ts`). This route is
 * the SSE-side counterpart: it opens a dedicated subscriber client, subscribes
 * to that job's channel (`jobChannel`, reused from `publisher.ts` so the
 * naming stays single-sourced across web↔worker), and forwards each message
 * verbatim as an SSE `data:` frame — the payload is already the `JobEvent`
 * JSON the worker validated and published, so no re-parsing is needed here.
 *
 * One Redis client per open stream (not a shared/pooled client): a
 * subscribed node-redis client is restricted to pub/sub commands, and a
 * dedicated connection lets the browser disconnect (or navigate away) tear
 * down its own subscription independently via the stream's `cancel()`.
 *
 * `force-dynamic`: this is a long-lived, per-request stream, never a
 * statically cacheable response.
 */
export const dynamic = "force-dynamic";

function resolveRedisUrl(): string {
	return process.env.REDIS_URL?.trim() || "redis://redis:6379";
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id: jobId } = await params;
	const channel = jobChannel(jobId);
	const client = createClient({ url: resolveRedisUrl() });
	const encoder = new TextEncoder();

	let closed = false;
	const cleanup = async () => {
		if (closed) return;
		closed = true;
		try {
			await client.unsubscribe(channel);
		} catch (error) {
			console.error("Failed to unsubscribe job stream", error);
		}
		try {
			await client.quit();
		} catch (error) {
			console.error("Failed to close job stream redis client", error);
		}
	};

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			client.on("error", (error: unknown) => {
				console.error("Job stream redis client error", error);
			});
			try {
				await client.connect();
				await client.subscribe(channel, (message: string) => {
					controller.enqueue(encoder.encode(`data: ${message}\n\n`));
				});
			} catch (error) {
				controller.error(error);
			}
		},
		cancel() {
			return cleanup();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
