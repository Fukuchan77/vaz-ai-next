import { createInngestEngine } from "@vaz/worker/src/inngest";
import { type ApprovalSignal, type DurableEngine, submitApproval } from "@vaz/worker/src/main";
import { z } from "zod";
import { authorizeJobAccess } from "@/lib/jobs";

/**
 * `POST /api/jobs/:id/approve` — receive an approval decision and resume the
 * suspended workflow (R3.4/3.5).
 *
 * Body contract (plan.md Interfaces/Contracts): `{ toolCallId, decision:
 * approve|reject, args? }`. The durable engine correlates a suspended step by
 * `jobId` + `stepId` (`apps/worker/src/main.ts` `ApprovalGate`/`ApprovalSignal`,
 * Task 13.6) — `toolCallId` carries that `stepId` value; the approval UI (Task
 * 14.5) reads it off the step's `step-start` `JobEvent` rather than an AI SDK
 * tool-call id, since HITL suspension in this workflow is step-granular, not
 * per individual tool invocation. `decision` maps to `ApprovalSignal.approved`;
 * `args` (edited tool arguments) passes through untouched when present.
 *
 * Fire-and-forget, mirroring `POST /api/jobs` (Task 14.1): submission returns
 * as soon as the engine has durably enqueued the resume event, decoupled from
 * the suspended workflow actually resuming (progress arrives over the Task
 * 14.2 SSE stream).
 *
 * AUTHORIZATION (R5.1, Task 21.4): delegated to `@/lib/jobs`'s
 * `authorizeJobAccess`, shared with the stream route — 400/401/404/403 in
 * that order (404 for a job with no row yet, closing the TOCTOU race between
 * `POST /api/jobs`'s 202 response and the worker's `jobStore.insert`; a
 * `found`, ownerless job — submitted anonymously, or predating Task 21.3 — is
 * not itself an authorization boundary, mirroring the existing acceptance of
 * anonymous submission, Task 18.3, so any authenticated caller may act on it).
 */
/** Wire contract for the approval decision body (plan.md Interfaces/Contracts). */
const approvalRequestSchema = z.object({
	toolCallId: z.uuid(),
	decision: z.enum(["approve", "reject"]),
	args: z.unknown().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id: jobId } = await params;
	const authz = await authorizeJobAccess(jobId);
	if (!authz.ok) return authz.response;

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
	}

	const signal = parseApprovalRequest(jobId, body);
	if (!signal) {
		return Response.json({ error: "Invalid approval request" }, { status: 400 });
	}

	try {
		// Inngest's real client type doesn't structurally narrow to the
		// engine-agnostic `DurableEngine` port (overloaded `createFunction`); cast
		// at this single edge, mirroring `apps/web/src/app/api/jobs/route.ts`.
		const engine = (await createInngestEngine()) as unknown as DurableEngine;
		await submitApproval(engine, signal);
	} catch (error) {
		console.error("Failed to submit approval", error);
		return Response.json({ error: "Failed to submit approval" }, { status: 500 });
	}

	return Response.json({ ok: true }, { status: 202 });
}

/** Validate the approval request body, returning `null` on any shape mismatch. */
function parseApprovalRequest(jobId: string, body: unknown): ApprovalSignal | null {
	const parsed = approvalRequestSchema.safeParse(body);
	if (!parsed.success) return null;
	const { toolCallId, decision, args } = parsed.data;

	return {
		jobId,
		stepId: toolCallId,
		approved: decision === "approve",
		...(args !== undefined ? { args } : {}),
	};
}
