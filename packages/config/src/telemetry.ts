import { OpenTelemetry } from "@ai-sdk/otel";
import { registerTelemetry } from "ai";

/**
 * Guards one-shot initialization: registration and the "not configured" warning
 * each happen at most once per process (NFR-4 fail-soft — warn once, then quiet).
 */
let initialized = false;

/**
 * Initialize observability for every AI SDK call (R4.1 / NFR-7).
 *
 * Registers the AI SDK ↔ OpenTelemetry bridge so all `generateText` /
 * `streamText` / agent calls emit spans to whatever OTel provider the host set
 * up (e.g. `registerOTel()` in `apps/web/instrumentation.ts`). Once registered,
 * telemetry is opt-out per call — no per-call wiring is needed here.
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
	initialized = true;

	// NFR-7: OpenTelemetry span collection is enabled from Phase 1, unconditionally.
	registerTelemetry(new OpenTelemetry());

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
