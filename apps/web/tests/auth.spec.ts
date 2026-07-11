/**
 * `apps/web/src/lib/auth.ts` (R5.1, Task 18.2) wires Auth.js (`next-auth@5`,
 * JWT session strategy — docs/spikes/phase5-idp.md decision) and maps the
 * authenticated session to the `{ userId, role }` runtime context tool
 * execution is scoped by (ADR-3, plan.md §Interfaces).
 *
 * `next-auth` itself is mocked (like `ai`/`@ai-sdk/otel` in telemetry.spec.ts):
 * its real `lib/env.js` imports a bare `next/server` specifier that Vite/Vitest
 * cannot resolve without Next's own bundler (Turbopack resolves it fine; this
 * is a Vitest ↔ next-auth ecosystem friction, not our code) — mocking keeps
 * this suite fast and network-free while still exercising our own logic
 * (provider selection, role resolution, session→runtimeContext mapping).
 */

const { NextAuthMock, GoogleMock, MicrosoftEntraIDMock } = vi.hoisted(() => ({
	NextAuthMock: vi.fn(() => ({
		handlers: { GET: vi.fn(), POST: vi.fn() },
		auth: vi.fn(),
		signIn: vi.fn(),
		signOut: vi.fn(),
	})),
	GoogleMock: vi.fn((opts?: Record<string, unknown>) => ({ id: "google", ...opts })),
	MicrosoftEntraIDMock: vi.fn((opts?: Record<string, unknown>) => ({
		id: "microsoft-entra-id",
		...opts,
	})),
}));

vi.mock("next-auth", () => ({ default: NextAuthMock }));
vi.mock("next-auth/providers/google", () => ({ default: GoogleMock }));
vi.mock("next-auth/providers/microsoft-entra-id", () => ({ default: MicrosoftEntraIDMock }));

describe("buildAuthProviders", () => {
	test("registers Microsoft Entra ID for the entra-id switch (default)", async () => {
		const { buildAuthProviders } = await import("@/lib/auth");
		const providers = buildAuthProviders("entra-id");
		expect(providers).toHaveLength(1);
		expect(providers[0]?.id).toBe("microsoft-entra-id");
	});

	test("registers Google for the google-workspace switch", async () => {
		const { buildAuthProviders } = await import("@/lib/auth");
		const providers = buildAuthProviders("google-workspace");
		expect(providers).toHaveLength(1);
		expect(providers[0]?.id).toBe("google");
	});
});

describe("resolveJwtRole", () => {
	test("returns undefined when there is no email (no user on JWT refresh)", async () => {
		const { resolveJwtRole } = await import("@/lib/auth");
		expect(resolveJwtRole(undefined)).toBeUndefined();
		expect(resolveJwtRole(null)).toBeUndefined();
	});

	test("resolves a VAZ role from the @vaz/config allowlist for a real email", async () => {
		const { resolveJwtRole } = await import("@/lib/auth");
		expect(resolveJwtRole("nobody@example.com")).toBe("member");
	});
});

describe("toRuntimeContext", () => {
	test("maps a null session (unauthenticated) to null userId/role", async () => {
		const { toRuntimeContext } = await import("@/lib/auth");
		expect(toRuntimeContext(null)).toEqual({ userId: null, role: null });
	});

	test("maps an authenticated session's user.id/role through", async () => {
		const { toRuntimeContext } = await import("@/lib/auth");
		expect(toRuntimeContext({ user: { id: "user_123", role: "admin" } })).toEqual({
			userId: "user_123",
			role: "admin",
		});
	});

	test("falls back to null when session.user is present but id/role are missing", async () => {
		const { toRuntimeContext } = await import("@/lib/auth");
		expect(toRuntimeContext({ user: {} })).toEqual({ userId: null, role: null });
	});
});

describe("NextAuth wiring", () => {
	test("exports handlers/auth/signIn/signOut", async () => {
		const mod = await import("@/lib/auth");
		expect(mod.handlers).toBeDefined();
		expect(typeof mod.auth).toBe("function");
		expect(typeof mod.signIn).toBe("function");
		expect(typeof mod.signOut).toBe("function");
	});

	test("passes session: { strategy: 'jwt' } and the AUTH_IDP-selected provider to NextAuth", async () => {
		await import("@/lib/auth");
		expect(NextAuthMock).toHaveBeenCalledWith(
			expect.objectContaining({
				session: { strategy: "jwt" },
				providers: expect.arrayContaining([expect.objectContaining({ id: "microsoft-entra-id" })]),
			}),
		);
	});
});
