import { initTelemetry } from "@vaz/config/telemetry";
import { registerOTel } from "@vercel/otel";

/**
 * Next.js instrumentation hook — invoked once per runtime at server startup.
 * Enables observability for every agent call from Phase 1 (R4.1 / NFR-7).
 *
 * `registerOTel` stands up the OpenTelemetry SDK and its OTLP trace exporter at
 * the host; the exporter ships spans to Langfuse when the standard
 * `OTEL_EXPORTER_OTLP_*` env vars are present. `initTelemetry` (from `@vaz/config`)
 * then registers the AI SDK ↔ OpenTelemetry bridge so all `streamText` / agent
 * calls emit spans onto that provider — no per-call wiring needed.
 *
 * Order matters: the OTel provider must exist (`registerOTel`) before the AI SDK
 * bridge attaches to it (`initTelemetry`). Both are fail-soft — absent telemetry
 * env warns at most once and never breaks startup (NFR-4).
 */
export function register() {
	registerOTel({ serviceName: "vaz-web" });
	initTelemetry();
}
