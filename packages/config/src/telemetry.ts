import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

/**
 * Guards one-shot initialization: once the OpenTelemetry bridge is registered,
 * the "not configured" warning happens at most once per process (NFR-4 fail-soft
 * — warn once, then quiet). Set only *after* a successful `registerTelemetry` so
 * that a failed registration can be retried on a later call.
 */
let initialized = false;

/**
 * The `runtimeContext` shape AI SDK call sites pass through `generateText`/
 * `streamText`/agent options (R4.2). All fields are optional: `jobId` is null
 * on the synchronous chat path (no durable job, Phase 1–2), and `userId` is
 * omitted/anonymous until auth lands (Phase 5).
 */
export interface TelemetryRuntimeContext {
	jobId?: string | null;
	userId?: string | null;
	agentName?: string | null;
}

/**
 * Lift `jobId`/`userId`/`agentName` from a call's `runtimeContext` onto `vaz.*`
 * span attributes (R4.2), so every span in a workflow — not just the
 * `functionId`-derived root span — carries the same identifiers and the whole
 * workflow is followable as a single trace in Langfuse.
 *
 * Missing/null fields are omitted rather than stringified, so an anonymous
 * `userId` or a null `jobId` never shows up as a literal "null"/"undefined"
 * attribute value.
 */
export function buildTelemetryAttributes(
	runtimeContext: TelemetryRuntimeContext | Record<string, unknown> | undefined,
): Record<string, string> {
	const attributes: Record<string, string> = {};
	const jobId = runtimeContext?.jobId;
	const userId = runtimeContext?.userId;
	const agentName = runtimeContext?.agentName;
	if (typeof jobId === "string") {
		attributes["vaz.job_id"] = jobId;
	}
	if (typeof userId === "string") {
		attributes["vaz.user_id"] = userId;
	}
	if (typeof agentName === "string") {
		attributes["vaz.agent_name"] = agentName;
	}
	return attributes;
}

/**
 * Initialize observability for every AI SDK call (R4.1 / NFR-7).
 *
 * Registers the AI SDK ↔ OpenTelemetry bridge so all `generateText` /
 * `streamText` / agent calls emit spans to whatever OTel provider the host set
 * up (e.g. `registerOTel()` in `apps/web/instrumentation.ts`). Once registered,
 * telemetry is opt-out per call — no per-call wiring is needed here.
 *
 * `enrichSpan` is wired to {@link buildTelemetryAttributes} so any call that
 * passes `jobId`/`userId`/`agentName` via `runtimeContext` gets those lifted
 * onto every span (operation, step, languageModel, tool) it emits (R4.2) —
 * making a whole multi-step, multi-tool workflow filterable as a single trace
 * in Langfuse. Callers opt in per call; this module only wires the mechanism.
 *
 * Langfuse OTLP export is opt-in via env (R4.3): the OTLP exporter (configured
 * at the host, keyed off `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`) ships the
 * emitted spans to Langfuse. When those are unset we warn exactly once and keep
 * running — OpenTelemetry spans are still emitted locally (fail-soft, NFR-4);
 * this function never throws.
 *
 * Idempotent: safe to call multiple times (registers and warns at most once).
 *
 * @param env Environment source (injectable for tests; defaults to `process.env`).
 */
export function initTelemetry(env: Record<string, string | undefined> = process.env): void {
	if (initialized) {
		return;
	}

	// NFR-7: OpenTelemetry span collection is enabled from Phase 1, unconditionally.
	// NFR-4 fail-soft: a wiring error here must never break server startup, so we
	// swallow it (warn once) and leave `initialized` false so a later call retries.
	try {
		registerTelemetry(
			new OpenTelemetry({
				enrichSpan: ({ runtimeContext }) => buildTelemetryAttributes(runtimeContext),
			}),
		);
	} catch (error) {
		console.warn(
			"[telemetry] Failed to register the OpenTelemetry bridge; " +
				"continuing without AI SDK telemetry (will retry on next init).",
			error,
		);
		return;
	}

	initialized = true;

	// R4.3: Langfuse OTLP export is only expected when its credentials are present.
	const langfuseConfigured = Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
	if (!langfuseConfigured) {
		console.warn(
			"[telemetry] Langfuse OTLP export not configured " +
				"(LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY unset); " +
				"OpenTelemetry spans are still emitted locally. Continuing without Langfuse.",
		);
	}
}
