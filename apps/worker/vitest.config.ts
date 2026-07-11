import { defineConfig } from "vitest/config";

/**
 * Worker (node) Vitest project for `apps/worker` (R1.9/NFR-1).
 *
 * Self-contained and usable standalone (`pnpm --filter @vaz/worker exec vitest
 * run`); also referenced by the root `vitest.config.ts` projects aggregator so
 * `mise run test:run` covers the whole workspace — mirroring the `apps/web`
 * precedent. Node environment (no jsdom / React): the worker is a long-running
 * Node process, so its unit tests exercise the engine-agnostic wiring
 * (durable-step port, span attribution, web↔worker submission) with injected
 * seams — no network, no durable engine, no LLM.
 */
export default defineConfig({
	test: {
		name: "worker",
		environment: "node",
		globals: true,
		include: ["tests/**/*.spec.{ts,tsx}"],
		exclude: ["tests/e2e/**", "node_modules/**"],
		passWithNoTests: true,
	},
});
