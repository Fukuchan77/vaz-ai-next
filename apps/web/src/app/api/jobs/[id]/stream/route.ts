import { parseRedisUrl } from "@vaz/schemas/infra-env";
import { jobEventSchema } from "@vaz/schemas/workflows";
import { jobChannel } from "@vaz/worker/src/publisher";
import { createClient } from "redis";
import { authorizeJobAccess } from "@/lib/jobs";

/**
 * `GET /api/jobs/:id/stream` — SSE Route Handler streaming a job's `JobEvent`
 * discriminated union to the browser (R3.6).
 *
 * The worker-side sink (`apps/worker/src/events.ts`) publishes
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
 *
 * AUTHORIZATION + VALIDATION (R5.1): delegated to `@/lib/jobs`'s
 * `authorizeJobAccess`, shared with the approve route (see that route's doc
 * comment for the full 400/401/404/403 policy, including the TOCTOU fix).
 */
export const dynamic = "force-dynamic";

function resolveRedisUrl(): string {
	return parseRedisUrl(process.env);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id: jobId } = await params;
	const authz = await authorizeJobAccess(jobId);
	if (!authz.ok) return authz.response;

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

	// A job-level terminal event (`completion`/`error` with no `stepId` — the
	// whole plan finished or failed, `packages/agents/src/supervisor.ts`'s
	// `dispatch`) closes the stream: without this, the SSE connection and its
	// dedicated Redis subscriber would stay open for the lifetime of the page,
	// and the client (`useJobStream`) would never see `done`. A frame that
	// fails to parse is forwarded as-is (fail-soft, mirrors the worker sink).
	function isTerminalJobEvent(message: string): boolean {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			return false;
		}
		const event = jobEventSchema.safeParse(parsed);
		if (!event.success) return false;
		return (
			(event.data.type === "completion" || event.data.type === "error") &&
			event.data.stepId === undefined
		);
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			client.on("error", (error: unknown) => {
				console.error("Job stream redis client error", error);
			});
			try {
				await client.connect();
				await client.subscribe(channel, (message: string) => {
					controller.enqueue(encoder.encode(`data: ${message}\n\n`));
					if (isTerminalJobEvent(message)) {
						controller.close();
						void cleanup();
					}
				});
			} catch (error) {
				await cleanup();
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
