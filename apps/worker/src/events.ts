import type { JobEventSink } from "@vaz/agents/supervisor";
import type { AgentDeps } from "@vaz/schemas/deps";
import { type JobEvent, jobEventSchema } from "@vaz/schemas/workflows";

/**
 * `apps/worker` progress-event persistence (R3.6).
 *
 * The supervisor emits a {@link JobEvent} discriminated union (step-start /
 * tool-call / token / completion / error) as it dispatches. This module is the
 * worker-side PRODUCER: it validates each event against the 11.2 contract, then
 * ① appends it to a durable store (DB — history for replay / late subscribers)
 * and ② publishes it to a pub/sub channel (Redis — live fan-out) so the SSE
 * Route Handler (Task 14.2) and `useJobStream` (14.4) can stream it to the
 * browser. Consumption (subscribe/read) is the SSE route's concern, not this.
 *
 * INJECTED PORTS (ADR-2/ADR-3, mirroring `main.ts`): the store and publisher are
 * seams, not concrete clients — this module imports neither `pg`/Drizzle nor a
 * Redis SDK. The container edge (Task 13.5) supplies a Postgres-backed
 * {@link JobEventStore} and a Redis-backed {@link JobEventPublisher}; tests
 * inject fakes, so no infra is needed to exercise the wiring.
 *
 * FAIL-SOFT: event persistence is the observability plane. A store or publish
 * error is logged and swallowed so a transient infra blip never fails the
 * durable job — the engine owns the job's resume state (13.2/13.6), not these
 * events. This mirrors the repo's fail-soft telemetry contract.
 */

/**
 * Durable history sink for job events (DB). Appended in emission order; the SSE
 * route replays it so a late subscriber sees prior events before the live tail.
 */
export interface JobEventStore {
	append(event: JobEvent): Promise<void> | void;
}

/** Live pub/sub fan-out for job events (Redis). Published per event for SSE. */
export interface JobEventPublisher {
	publish(event: JobEvent): Promise<void> | void;
}

/** Injected persistence ports for {@link createJobEventSink}. Both optional:
 * R3.6 permits "DB **or** Redis pub/sub" — supply either, both, or neither. */
export interface CreateJobEventSinkOptions {
	store?: JobEventStore;
	publisher?: JobEventPublisher;
}

/**
 * Minimal, payload-free correlation fields for a log record (R4.7 privacy): the
 * event's identity/type only — never `result` / `args` / token `delta`, which
 * may carry user content or PII. Read defensively so a malformed event still
 * produces a diagnosable log line.
 */
function correlation(event: JobEvent | { jobId?: unknown; type?: unknown; stepId?: unknown }) {
	const fields: Record<string, unknown> = {};
	if (typeof event.jobId === "string") fields.jobId = event.jobId;
	if (typeof event.type === "string") fields.type = event.type;
	if ("stepId" in event && typeof event.stepId === "string") fields.stepId = event.stepId;
	return fields;
}

/**
 * Build the worker's {@link JobEventSink} — the value wired into
 * `runJob({ emit })` (Task 13.2). Each event is validated against the 11.2
 * `jobEventSchema`, then persisted to the store and published to the pub/sub
 * channel. Store and publish are independent and each fail-soft: one failing
 * never blocks the other, and neither ever rejects the returned sink (so the
 * supervisor's awaited `emit` cannot fail the job on an observability error).
 */
export function createJobEventSink(
	deps: AgentDeps,
	options: CreateJobEventSinkOptions = {},
): JobEventSink {
	const { store, publisher } = options;

	return async (event: JobEvent): Promise<void> => {
		// Validate at the persistence boundary (defense-in-depth: the supervisor
		// is the only producer, but the wire contract is enforced here too). A
		// malformed event is dropped, not persisted — logged without its payload.
		const parsed = jobEventSchema.safeParse(event);
		if (!parsed.success) {
			deps.logger.warn("Dropped malformed job event", {
				...correlation(event),
				issues: parsed.error.issues.length,
			});
			return;
		}
		const validated = parsed.data;

		// Durable history first so a subscriber that joins mid-publish can replay
		// prior events before the live tail. Fail-soft, independent of publish.
		if (store) {
			try {
				await store.append(validated);
			} catch (error) {
				deps.logger.error("Failed to persist job event", {
					...correlation(validated),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		// Live fan-out. Runs even if the store append failed above.
		if (publisher) {
			try {
				await publisher.publish(validated);
			} catch (error) {
				deps.logger.error("Failed to publish job event", {
					...correlation(validated),
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};
}
