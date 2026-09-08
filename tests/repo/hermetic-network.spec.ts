/**
 * X-2 proof test: the hermetic network guard (`tests/setup/hermetic-network.ts`)
 * must actually fire, not silently no-op. This runs in the `repo` project,
 * which loads the same setup file every other project loads.
 */
describe("hermetic network guard (X-2)", () => {
	test("a real fetch() call is blocked during a unit test run", async () => {
		await expect(fetch("https://example.com")).rejects.toThrow(/Hermetic network guard/);
	});

	test("a test can still opt in to a stubbed fetch for its own scope", async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
		vi.stubGlobal("fetch", mockFetch);
		try {
			const res = await fetch("https://example.com");
			expect(await res.text()).toBe("ok");
			expect(mockFetch).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
		}

		// The guard is back in place once the stub is torn down.
		await expect(fetch("https://example.com")).rejects.toThrow(/Hermetic network guard/);
	});
});
