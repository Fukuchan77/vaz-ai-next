import type { JobEvent } from "@vaz/schemas/workflows";
import { createJobEventPublisher, jobChannel, type RedisPublisher } from "../src/publisher";

/**
 * Redis-backed JobEventPublisher (R3.6 live fan-out).
 *
 * The publisher is structural over a minimal {@link RedisPublisher} seam (no
 * `redis` import here), so a fake client exercises it with no Redis running —
 * the concrete `createClient()` is wired at the container edge. Each
 * job publishes to its own channel (`job:<jobId>`) so the SSE route
 * subscribes per job.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TS_ISO = "2026-07-08T00:00:00.000Z";

function fakeRedis(): {
	client: RedisPublisher;
	published: Array<{ channel: string; message: string }>;
} {
	const published: Array<{ channel: string; message: string }> = [];
	return {
		published,
		client: {
			publish(channel: string, message: string) {
				published.push({ channel, message });
				return Promise.resolve(1);
			},
		},
	};
}

const event: JobEvent = { jobId: JOB_ID, ts: TS_ISO, type: "completion" };

describe("createJobEventPublisher (R3.6)", () => {
	test("publishes the JSON-serialized event to the per-job channel", async () => {
		const { client, published } = fakeRedis();
		await createJobEventPublisher(client).publish(event);
		expect(published).toHaveLength(1);
		expect(published[0]?.channel).toBe(`job:${JOB_ID}`);
		expect(JSON.parse(published[0]?.message ?? "")).toEqual(event); // round-trips
	});

	test("honors a custom channel prefix", async () => {
		const { client, published } = fakeRedis();
		await createJobEventPublisher(client, { channelPrefix: "vaz-jobs" }).publish(event);
		expect(published[0]?.channel).toBe(`vaz-jobs:${JOB_ID}`);
	});

	test("jobChannel builds the per-job channel name", () => {
		expect(jobChannel(JOB_ID)).toBe(`job:${JOB_ID}`);
		expect(jobChannel(JOB_ID, "p")).toBe(`p:${JOB_ID}`);
	});
});
