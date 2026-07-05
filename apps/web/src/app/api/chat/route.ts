import { type AgentDeps, createChatAgent } from "@vaz/agents/index";
import { chatRequestSchema } from "@vaz/schemas/chat";
import { createUIMessageStreamResponse, toUIMessageStream, type UIMessage } from "ai";

/**
 * `POST /api/chat` — thin HTTP⇔Agent adapter (R1.5/1.7).
 *
 * The route owns only HTTP concerns: validate the request body with the shared
 * Zod contract, construct the agent's runtime `deps`, then hand off to
 * `@vaz/agents`. Orchestration (model resolution, tools, stop condition) lives
 * in `createChatAgent`, not here. The returned agent stream is bridged through
 * `toUIMessageStream` → `createUIMessageStreamResponse` to keep the exact same
 * `useChat`-compatible response shape as before the monorepo split (R1.7).
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

	// Runtime deps injected into the agent (ADR-3). Phase 1 is stateless (`db: null`)
	// and uses the real wall clock; the logger is a console-backed sink that records
	// only the message and any explicitly-passed fields (raw prompts / tool I/O are
	// never forwarded here, honoring the R4.7 privacy contract). A DB-backed deps
	// bundle and audit sink arrive in later phases.
	const deps: AgentDeps = {
		db: null,
		logger: {
			debug: (message, fields) =>
				fields ? console.debug(message, fields) : console.debug(message),
			info: (message, fields) => (fields ? console.info(message, fields) : console.info(message)),
			warn: (message, fields) => (fields ? console.warn(message, fields) : console.warn(message)),
			error: (message, fields) =>
				fields ? console.error(message, fields) : console.error(message),
		},
		now: () => new Date(),
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
