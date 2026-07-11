import type { JobEvent } from "@vaz/schemas/workflows";
import type { JobEventPublisher } from "./events";

/**
 * `apps/worker` Redis-backed progress-event publisher (R3.6 live fan-out).
 *
 * Concrete implementation of the {@link JobEventPublisher} port (`events.ts`):
 * each {@link JobEvent} is published to a per-job Redis channel (`job:<jobId>`)
 * so the SSE Route Handler subscribes to exactly one job's stream.
 *
 * Structural over a minimal {@link RedisPublisher} seam — this module never
 * imports the `redis` SDK; the concrete `createClient()` connection is built and
 * injected at the container edge, so the publisher stays unit-testable
 * with a fake client and no Redis running.
 */

/** Minimal Redis publish seam (node-redis `client.publish(channel, message)`). */
export interface RedisPublisher {
	publish(channel: string, message: string): Promise<unknown> | unknown;
}

/** Options for {@link createJobEventPublisher}. */
export interface CreateJobEventPublisherOptions {
	/** Channel prefix; the per-job channel is `${channelPrefix}:${jobId}` (default `job`). */
	channelPrefix?: string;
}

/** The Redis pub/sub channel a job's events are published to (SSE subscribes here). */
export function jobChannel(jobId: string, prefix = "job"): string {
	return `${prefix}:${jobId}`;
}

/**
 * Build the Redis-backed {@link JobEventPublisher}: publish each event as JSON to
 * its per-job channel. The SSE route subscribes to `job:<jobId>` and forwards
 * the parsed {@link JobEvent} to the browser (R3.6).
 */
export function createJobEventPublisher(
	client: RedisPublisher,
	options: CreateJobEventPublisherOptions = {},
): JobEventPublisher {
	const prefix = options.channelPrefix ?? "job";
	return {
		async publish(event: JobEvent) {
			await client.publish(jobChannel(event.jobId, prefix), JSON.stringify(event));
		},
	};
}
