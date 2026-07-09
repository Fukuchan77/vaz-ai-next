import { randomUUID } from "node:crypto";
import { supervisorPlanSchema } from "@vaz/schemas/workflows";
import { createInngestEngine } from "@vaz/worker/src/inngest";
import { type DurableEngine, type JobRequest, submitJob } from "@vaz/worker/src/main";

/**
 * `POST /api/jobs` — submit a supervisor workflow for durable execution (R3.2).
 *
 * The route validates the body against the shared `SupervisorPlan` contract
 * (`@vaz/schemas/workflows`), generates the job's correlation id, and hands it
 * to the durable engine via `submitJob` — submission returns as soon as the
 * engine has durably enqueued the event, decoupled from execution in
 * `apps/worker` (R3.2). The returned `jobId` is what `GET /api/jobs/:id/stream`
 * (Task 14.2) and `POST /api/jobs/:id/approve` (Task 14.3) correlate against.
 */
export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
	}

	const parsed = supervisorPlanSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid job request", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	// userId is null until Phase 5 auth (18.2) lands; decoupled submission (R3.2)
	// doesn't require identity.
	const request: JobRequest = { jobId: randomUUID(), userId: null, plan: parsed.data };

	try {
		// Inngest's real client type doesn't structurally narrow to the
		// engine-agnostic `DurableEngine` port (overloaded `createFunction`); cast
		// at this single edge, mirroring `apps/worker/src/inngest.ts`'s adapters.
		const engine = (await createInngestEngine()) as unknown as DurableEngine;
		await submitJob(engine, request);
	} catch (error) {
		console.error("Failed to submit job", error);
		return Response.json({ error: "Failed to submit job" }, { status: 500 });
	}

	// 202: the job is durably enqueued, not yet executed — mirrors the R3.2
	// web↔worker decoupling (execution progress arrives over the SSE stream).
	return Response.json({ jobId: request.jobId }, { status: 202 });
}
