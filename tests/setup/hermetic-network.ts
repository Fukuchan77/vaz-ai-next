/**
 * X-2: structural guarantee that unit tests never reach the real network.
 * Every agent/tool under test is exercised with an injected seam
 * (`MockLanguageModelV4`, `vi.mock`, a stubbed `fetch`) — this setup file makes
 * a mock-injection gap fail loudly instead of silently placing a real HTTP call,
 * mirroring `fastapi-pydantic-ai-agent/tests/support/hermetic.py` and
 * `pydantic-ai-sandbox`'s `connect_ex`/`getaddrinfo` guard
 * (docs/cross-repo-adoption-backlog.md, X-2).
 *
 * Scope is `fetch` (Node's built-in `fetch` is undici under the hood, so
 * blocking it covers both) — the same scope the backlog item calls out. It does
 * not touch `node:net`/`node:tls`, since the Postgres/Redis clients used
 * elsewhere in this workspace are always `vi.mock`'d in unit tests (never
 * given a real connection string), not routed through `fetch`.
 *
 * A test that legitimately exercises fetch-consuming code stubs it itself
 * (`vi.stubGlobal("fetch", mockFn)` + `vi.unstubAllGlobals()` in `afterEach`) —
 * that swaps this guard out for the duration of the test and back afterward,
 * so this file never needs an escape hatch of its own.
 */

function hermeticFetchGuard(input: unknown): Promise<never> {
	const target =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input instanceof Request
					? input.url
					: String(input);

	// Rejects (rather than throwing synchronously) to match real fetch()'s
	// contract of always returning a Promise — callers awaiting or chaining
	// `.catch()`/`.rejects` on the result see the failure the way they would
	// for a genuine network error.
	return Promise.reject(
		new Error(
			`Hermetic network guard (X-2): blocked a real fetch("${target}") during a unit test run. ` +
				"Unit tests must not reach the network — inject a seam instead " +
				'(MockLanguageModelV4, vi.mock, or vi.stubGlobal("fetch", ...) for this one call).',
		),
	);
}

Object.defineProperty(globalThis, "fetch", {
	configurable: true,
	writable: true,
	value: hermeticFetchGuard,
});
