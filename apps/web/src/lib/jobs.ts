import { createJobStore, type JobOwnerLookup } from "@vaz/worker/src/stores";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getWebDb } from "./db";

export type { JobOwnerLookup };

/**
 * `apps/web` job-ownership lookup + authorization (R5.1;
 * adversarial-review fix for the null-owner TOCTOU gap).
 *
 * Mirrors `apps/web/src/lib/audit.ts`'s pattern: reuses `@vaz/worker`'s
 * already-tested `JobStore` port (`createJobStore`) over the
 * shared, lazily built, process-cached Postgres client (`apps/web/src/lib/db.ts`),
 * instead of duplicating the query or opening a second pool.
 *
 * The approve/stream routes (`apps/web/src/app/api/jobs/[id]/{approve,stream}
 * /route.ts`) both used to repeat an identical 4-step authorization sequence
 * inline; `authorizeJobAccess` centralizes it so a future policy change only
 * needs one edit, and the null-owner race below can only be fixed once.
 */

/**
 * Look up who owns `jobId` (`job.userId`, persisted at job start by `runJob`).
 */
export async function findJobOwnerUserId(
	jobId: string,
	env: Record<string, string | undefined> = process.env,
): Promise<JobOwnerLookup> {
	const db = await getWebDb(env);
	return createJobStore(db).findOwnerUserId(jobId);
}

/** A rejected `authorizeJobAccess` call — the caller returns this `Response` directly. */
export interface JobAccessDenied {
	ok: false;
	response: Response;
}

/** A successful `authorizeJobAccess` call — the caller may proceed as `callerId`. */
export interface JobAccessGranted {
	ok: true;
	callerId: string;
}

/**
 * Authorize the current session against `jobId` (uuid-validate → session
 * check → ownership compare), shared by the approve and stream routes.
 *
 * - 400 if `jobId` is not a `z.uuid()`.
 * - 401 if there is no authenticated session.
 * - 404 if the job has no row yet — closes the TOCTOU race between `POST
 *   /api/jobs`'s 202 response (event durably enqueued) and the worker's
 *   `jobStore.insert` (job row persisted): during that window an unrelated
 *   authenticated caller who learns the jobId must NOT be treated as
 *   authorized just because the ownership lookup came back empty.
 * - 403 if the job has a recorded owner and the caller isn't them.
 * - Otherwise granted — this also covers the intentional `userId === null`
 *   anonymous-submission case (any authenticated caller may act on it),
 *   unchanged from before this fix.
 */
export async function authorizeJobAccess(
	jobId: string,
): Promise<JobAccessDenied | JobAccessGranted> {
	if (!z.uuid().safeParse(jobId).success) {
		return { ok: false, response: Response.json({ error: "Invalid job id" }, { status: 400 }) };
	}

	const session = await auth();
	const callerId = session?.user?.id ?? null;
	if (!callerId) {
		return { ok: false, response: Response.json({ error: "Unauthorized" }, { status: 401 }) };
	}

	const owner = await findJobOwnerUserId(jobId);
	if (!owner.found) {
		return { ok: false, response: Response.json({ error: "Job not found" }, { status: 404 }) };
	}
	if (owner.userId !== null && owner.userId !== callerId) {
		return { ok: false, response: Response.json({ error: "Forbidden" }, { status: 403 }) };
	}

	return { ok: true, callerId };
}
