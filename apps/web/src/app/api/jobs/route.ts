import { randomUUID } from "node:crypto";
import { supervisorPlanSchema } from "@vaz/schemas/workflows";
import { createInngestEngine } from "@vaz/worker/src/inngest";
import { type DurableEngine, type JobRequest, submitJob } from "@vaz/worker/src/main";
import { z } from "zod";
import { auth, toRuntimeContext } from "@/lib/auth";

/**
 * `POST /api/jobs` — submit a supervisor workflow for durable execution (R3.2).
 *
 * The route validates the body against the shared `SupervisorPlan` contract
 * (`@vaz/schemas/workflows`), generates the job's correlation id, and hands it
 * to the durable engine via `submitJob` — submission returns as soon as the
 * engine has durably enqueued the event, decoupled from execution in
 * `apps/worker` (R3.2). The returned `jobId` is what `GET /api/jobs/:id/stream`
 * (Task 14.2) and `POST /api/jobs/:id/approve` (Task 14.3) correlate against.
 *
 * `JobRequest.userId` (R5.1, Task 18.3) is resolved from the Auth.js session
 * (`auth()`/`toRuntimeContext()`, `apps/web/src/lib/auth.ts`, Task 18.2) —
 * `null` when unauthenticated (no IdP tenant is available to verify a real
 * sign-in round-trip yet — deferred, see tasks.md Task 18.3). Decoupled
 * submission (R3.2) does not itself require identity.
 *
 * IDEMPOTENCY (adversarial-review fix): `submitJob`'s `engine.send({ ..., id })`
 * only dedupes a retried/replayed event carrying the SAME id — it can't help a
 * client-side retry (network timeout, double submit) that never reused
 * anything, since `jobId` used to be minted fresh on every call. An optional
 * client-supplied `Idempotency-Key` header lets a caller retry safely: reusing
 * the same header value collapses to the one durable run Inngest already
 * dedupes on `id`, instead of dispatching the plan twice under two fresh ids.
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

	const idempotencyKey = req.headers.get("Idempotency-Key");
	if (idempotencyKey !== null && !z.uuid().safeParse(idempotencyKey).success) {
		return Response.json(
			{ error: "Invalid Idempotency-Key header (must be a UUID)" },
			{ status: 400 },
		);
	}

	const session = await auth();
	const { userId } = toRuntimeContext(session);
	const request: JobRequest = { jobId: idempotencyKey ?? randomUUID(), userId, plan: parsed.data };

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
