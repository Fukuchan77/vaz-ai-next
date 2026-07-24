import {
	type EvalResponse,
	evalRequestSchema,
	evalResponseSchema,
} from "@vaz/schemas/agent-service";

/**
 * Tier2 faithfulness/relevancy client (Req 5.2): calls `services/agent`'s
 * `POST /eval/faithfulness` and `POST /eval/relevancy` per golden case and
 * validates each response with the thin Zod wrapper (`@vaz/schemas/agent-service`,
 * Task 6.4) — the same runtime-validation role that wrapper plays for the
 * ingest `/parse` client (`@vaz/rag/ingest#createAgentServiceParser`).
 *
 * `contexts` grounds both axes: what the driven run's answer should be
 * faithful/relevant to. The nightly golden set (`nightly.ts#GOLDEN_SET`)
 * exercises `getCurrentTime` tool calls and tool-free general knowledge, not
 * RAG retrieval (the nightly harness runs with `db: null`, so
 * `searchDocuments` is never registered — see `chat-agent.ts#buildChatTools`).
 * So here "context" is generalized to whatever tool output grounds the final
 * answer, not retrieved documents specifically; {@link deriveTier2Contexts}
 * derives it from the run's tool results. A case with no tool calls has
 * nothing to check faithfulness/relevancy against, so it is skipped for
 * tier2 (not sent with an empty `contexts`, which `evalRequestSchema`
 * rejects via `min(1)`) — this is a per-case skip layered under the
 * service-level skip Req 5.2 requires when `services/agent` is unconfigured.
 */

/** One eval axis's per-case result: score/verdict plus its own token spend. */
export interface Tier2AxisScore {
	readonly score: number;
	readonly verdict: boolean;
	readonly totalTokens: number;
}

/** Faithfulness + relevancy for one golden case, or why tier2 did not run for it. */
export type Tier2CaseResult =
	| {
			readonly skipped: false;
			readonly faithfulness: Tier2AxisScore;
			readonly relevancy: Tier2AxisScore;
	  }
	| {
			readonly skipped: true;
			// "request-failed": network error or non-2xx (service down/misbehaving).
			// "invalid-response": the service responded but its body didn't conform
			// to `evalResponseSchema` — a boundary-contract drift, distinct from an
			// unreachable service, so a nightly reader can tell them apart instead
			// of both silently reading as "service was down".
			readonly reason: "no-context" | "request-failed" | "invalid-response";
			readonly error?: string;
	  };

/** Input to {@link runTier2Case}: the question/answer plus the grounding context(s). */
export interface Tier2EvalRequest {
	readonly question: string;
	readonly contexts: readonly string[];
	readonly answer: string;
}

/**
 * Thrown when `services/agent` responds (2xx) but its body doesn't conform to
 * `evalResponseSchema` — a boundary-contract drift, not an unreachable
 * service. {@link runTier2Case} maps this to `reason: "invalid-response"`
 * rather than lumping it in with `"request-failed"`.
 */
class Tier2InvalidResponseError extends Error {}

async function callTier2Endpoint(
	baseUrl: string,
	path: "/eval/faithfulness" | "/eval/relevancy",
	request: Tier2EvalRequest,
): Promise<EvalResponse> {
	const body = evalRequestSchema.parse({
		question: request.question,
		contexts: [...request.contexts],
		answer: request.answer,
	});

	let response: Response;
	try {
		response = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (error) {
		throw new Error(
			`services/agent is unreachable at ${baseUrl} (POST ${path}): ` +
				(error instanceof Error ? error.message : String(error)),
		);
	}
	if (!response.ok) {
		throw new Error(`services/agent ${path} returned ${response.status} (POST ${baseUrl}${path})`);
	}
	const json = await response.json();
	const result = evalResponseSchema.safeParse(json);
	if (!result.success) {
		throw new Tier2InvalidResponseError(
			`services/agent ${path} response did not conform to evalResponseSchema (POST ${baseUrl}${path}): ` +
				result.error.message,
		);
	}
	return result.data;
}

function toAxisScore(response: EvalResponse): Tier2AxisScore {
	return {
		score: response.score,
		verdict: response.verdict,
		totalTokens: response.usage.total_tokens,
	};
}

/**
 * Runs both tier2 axes for one golden case (Req 5.2). Never throws — a
 * network error, a non-2xx response, or a schema-invalid response is caught
 * and reported as `{ skipped: true, reason: "request-failed" }` so a tier2
 * hiccup enriches a nightly case with less data rather than failing it
 * outright (mirrors `runNightlyEval`'s own per-case `case-failed` handling).
 */
export async function runTier2Case(
	baseUrl: string,
	request: Tier2EvalRequest,
): Promise<Tier2CaseResult> {
	try {
		const [faithfulness, relevancy] = await Promise.all([
			callTier2Endpoint(baseUrl, "/eval/faithfulness", request),
			callTier2Endpoint(baseUrl, "/eval/relevancy", request),
		]);
		return {
			skipped: false,
			faithfulness: toAxisScore(faithfulness),
			relevancy: toAxisScore(relevancy),
		};
	} catch (error) {
		return {
			skipped: true,
			reason: error instanceof Tier2InvalidResponseError ? "invalid-response" : "request-failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Derives `contexts` from a completed run's tool results (Req 5.2) — see the
 * module doc for why this is tool outputs in general, not RAG chunks
 * specifically. Returns `undefined` (not `[]`) when the run made no tool
 * calls, since `evalRequestSchema`'s `contexts` is `min(1)` — the caller
 * skips tier2 for that case rather than sending a request with no grounding.
 */
export function deriveTier2Contexts(
	toolResults: ReadonlyArray<{ readonly toolName: string; readonly output: unknown }>,
): readonly string[] | undefined {
	const contexts = toolResults.map((result) =>
		JSON.stringify({ tool: result.toolName, output: result.output }),
	);
	return contexts.length > 0 ? contexts : undefined;
}

/**
 * Resolves `AGENT_SERVICE_URL` for nightly tier2. Unlike the ingest CLI's
 * `resolveAgentServiceUrl` (`@vaz/rag/ingest`, fail-fast — `--via-parser` is
 * an explicit opt-in), this returns `undefined` on unset/blank rather than
 * throwing: Req 5.2 requires the whole tier2 stage to skip, not fail, when
 * `services/agent` is not configured.
 */
export function resolveTier2BaseUrlFromEnv(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const url = env.AGENT_SERVICE_URL?.trim();
	return url ? url : undefined;
}
