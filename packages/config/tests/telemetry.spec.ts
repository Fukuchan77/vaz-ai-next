/**
 * Fail-soft contract for `initTelemetry` (NFR-4 / R4.3).
 *
 * `ai#registerTelemetry` and `@ai-sdk/otel#OpenTelemetry` are mocked so we can
 * (a) assert one-shot registration + single Langfuse warning, and (b) force a
 * registration error and prove it does not propagate (startup stays alive) and
 * that a later call retries. Module state (`initialized`) is reset per test via
 * `vi.resetModules()` + dynamic import.
 */

const { registerTelemetry, OpenTelemetryCtor } = vi.hoisted(() => ({
	registerTelemetry: vi.fn(),
	OpenTelemetryCtor: vi.fn(),
}));

vi.mock("ai", () => ({ registerTelemetry }));
vi.mock("@ai-sdk/otel", () => ({ OpenTelemetry: OpenTelemetryCtor }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});

test("registers once and warns once when Langfuse is unconfigured", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { initTelemetry } = await import("@vaz/config/telemetry");

	expect(() => initTelemetry({})).not.toThrow();
	initTelemetry({}); // idempotent: second call is a no-op

	expect(registerTelemetry).toHaveBeenCalledTimes(1);
	const langfuseWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("Langfuse"));
	expect(langfuseWarnings).toHaveLength(1);

	warn.mockRestore();
});

test("does not warn about Langfuse when both credentials are present", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const { initTelemetry } = await import("@vaz/config/telemetry");

	initTelemetry({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" });

	expect(registerTelemetry).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls.filter((c) => String(c[0]).includes("Langfuse"))).toHaveLength(0);

	warn.mockRestore();
});

test("registration failure is fail-soft (no throw) and retryable", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	registerTelemetry.mockImplementationOnce(() => {
		throw new Error("otel exporter down");
	});
	const { initTelemetry } = await import("@vaz/config/telemetry");

	// First call: registration throws internally but startup must survive.
	expect(() => initTelemetry({})).not.toThrow();
	// `initialized` stayed false, so a subsequent call actually registers.
	expect(() => initTelemetry({})).not.toThrow();

	expect(registerTelemetry).toHaveBeenCalledTimes(2);

	warn.mockRestore();
});
