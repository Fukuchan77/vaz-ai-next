import { type AgentDeps, createChatAgent } from "@vaz/agents/index";
import { createConsoleLogger } from "@vaz/config/logger";
import { chatRequestSchema } from "@vaz/schemas/chat";
import { createUIMessageStreamResponse, toUIMessageStream, type UIMessage } from "ai";
import { createAuditSink } from "@/lib/audit";
import { auth, toRuntimeContext } from "@/lib/auth";
import { getWebDb } from "@/lib/db";

/**
 * `POST /api/chat` — thin HTTP⇔Agent adapter (R1.5/1.7).
 *
 * The route owns only HTTP concerns: validate the request body with the shared
 * Zod contract, construct the agent's runtime `deps`, then hand off to
 * `@vaz/agents`. Orchestration (model resolution, tools, stop condition) lives
 * in `createChatAgent`, not here. The returned agent stream is bridged through
 * `toUIMessageStream` → `createUIMessageStreamResponse` to keep the exact same
 * `useChat`-compatible response shape as before the monorepo split (R1.7).
 *
 * `deps.runtimeContext` (R5.1) carries the caller's `{ userId,
 * role }`, resolved from the Auth.js session (`auth()`/`toRuntimeContext()`,
 * `apps/web/src/lib/auth.ts`) — `{ userId: null, role: null }` when
 * unauthenticated. This route does not itself require authentication (no
 * IdP tenant is available to verify a real sign-in round-trip yet); it only
 * threads the resolved scope through.
 */
export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
	}

	const parsed = chatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid chat request", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	// Runtime deps injected into the agent (ADR-3). The logger is a console-backed
	// sink that records only the message and any explicitly-passed fields (raw
	// prompts / tool I/O are never forwarded here, honoring the R4.7 privacy
	// contract; single implementation, R3.1). Real wall clock (composition root, ADR-3).
	const session = await auth();
	const logger: AgentDeps["logger"] = createConsoleLogger();

	// RAG + audit wiring (adversarial-review fix): when a DB is
	// configured, `db` lets `isRagDatabase` register the `searchDocuments` tool
	// (R2.4 citations, R5.2 delimited injection, R5.3 sticky taint) and `audit`
	// lets the tool-execution audit hook (R5.5) actually persist. Fail-soft
	// (NFR-4): a broken/unset `DATABASE_URL` must not break chat, which already
	// works without RAG — fall back to the Phase 1 `db: null` scaffold and log a
	// warning instead of throwing.
	let db: AgentDeps["db"] = null;
	let audit: AgentDeps["audit"];
	if (process.env.DATABASE_URL?.trim()) {
		try {
			db = await getWebDb();
			audit = await createAuditSink({ db, logger, now: () => new Date() });
		} catch (error) {
			logger.warn("Failed to wire RAG/audit for the chat route; continuing without them", {
				error: error instanceof Error ? error.message : String(error),
			});
			db = null;
			audit = undefined;
		}
	}

	const deps: AgentDeps = {
		db,
		logger,
		now: () => new Date(),
		runtimeContext: toRuntimeContext(session),
		audit,
	};

	// Constructing the stream can throw synchronously before any bytes are sent —
	// e.g. `convertToModelMessages` on a malformed (but schema-loose) part, or
	// `resolveModel()` rejecting an invalid provider env. Guard it so those surface
	// as a 500 JSON body instead of an unhandled rejection (symmetric with the 400s
	// above). Raw prompts / tool I/O are never logged (R4.7 privacy contract).
	try {
		const result = await createChatAgent(deps).stream({
			messages: parsed.data.messages as UIMessage[],
		});

		return createUIMessageStreamResponse({
			stream: toUIMessageStream({ stream: result.stream }),
		});
	} catch (error) {
		deps.logger.error("Failed to start chat stream", {
			error: error instanceof Error ? error.message : String(error),
		});
		return Response.json({ error: "Failed to process chat request" }, { status: 500 });
	}
}
