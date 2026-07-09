import { createInngestEngine } from "@vaz/worker/src/inngest";
import { type ApprovalSignal, type DurableEngine, submitApproval } from "@vaz/worker/src/main";
import { z } from "zod";

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
 */
/** Wire contract for the approval decision body (plan.md Interfaces/Contracts). */
const approvalRequestSchema = z.object({
	toolCallId: z.uuid(),
	decision: z.enum(["approve", "reject"]),
	args: z.unknown().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id: jobId } = await params;
	if (!z.uuid().safeParse(jobId).success) {
		return Response.json({ error: "Invalid job id" }, { status: 400 });
	}

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
