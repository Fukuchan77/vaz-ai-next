import { createConsoleLogger } from "../src/logger";

/**
 * Single {@link createConsoleLogger} implementation (R3.1) shared by every
 * composition root that used to duplicate this same 4-method console sink:
 * `apps/web/src/app/api/chat/route.ts` (inline), `apps/worker/src/start.ts`,
 * `apps/worker/src/main.ts` (`buildWorkerDeps`'s default), and
 * `packages/rag/bin/ingest.ts`.
 */
describe("createConsoleLogger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns a Logger with the four level methods", () => {
		const logger = createConsoleLogger();
		for (const level of ["debug", "info", "warn", "error"] as const) {
			expect(typeof logger[level]).toBe("function");
		}
	});

	test("calls console.info with the message only when fields is omitted", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});
		createConsoleLogger().info("hello");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith("hello");
	});

	test("calls console.info with message and fields when fields is provided", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => {});
		createConsoleLogger().info("hello", { a: 1 });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith("hello", { a: 1 });
	});

	test("routes debug/warn/error to their respective console methods", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logger = createConsoleLogger();

		logger.debug("d");
		logger.warn("w");
		logger.error("e");

		expect(debugSpy).toHaveBeenCalledWith("d");
		expect(warnSpy).toHaveBeenCalledWith("w");
		expect(errorSpy).toHaveBeenCalledWith("e");
	});
});
