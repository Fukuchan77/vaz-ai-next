import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/**
 * X-15 guard: `.github/dependabot.yml` must exist, cover every ecosystem this
 * workspace actually has (npm/pnpm workspace, the uv-managed Python sidecar,
 * GitHub Actions), and keep its `ignore:` list for the npm ecosystem in sync
 * with root `package.json` — so a bump to one of the {@link HELD_BACK} ranges
 * doesn't silently leave a stale (or missing) `ignore:` entry behind. Modeled
 * on `fastapi-pydantic-ai-agent/tests/unit/test_dependabot_config.py`
 * (docs/cross-repo-adoption-backlog.md, X-15).
 *
 * {@link HELD_BACK} mixes two different reasons a dependency's `ignore:` entry
 * exists, both mechanically checked the same way ("package.json pins major N,
 * dependabot.yml ignores >= N+1"): `vitest` / `@vitest/coverage-v8` /
 * `@types/node` are genuinely held back — AGENTS.md/CLAUDE.md's "Deliberately
 * held-back majors" bullet is about these; `typescript` is NOT held back (the
 * workspace root already adopted its current major, 7) — only a *further*
 * jump is gated, per AGENTS.md's separate "TypeScript 7 is adopted..." bullet
 * and the KNOWN GAP comment in dependabot.yml itself (packages/schemas still
 * needs 6.x for openapi-typescript, a constraint dependabot's workspace-wide
 * `ignore:` can't scope to one manifest).
 */

interface DependabotUpdate {
	"package-ecosystem"?: string;
	directory?: string;
	ignore?: Array<{ "dependency-name"?: string; versions?: string[] }>;
}

interface DependabotDoc {
	updates?: DependabotUpdate[];
}

interface PackageJson {
	devDependencies?: Record<string, string>;
}

const ROOT = new URL("../../", import.meta.url);

// package.json pins each of these at `heldMajor`; dependabot.yml must ignore
// the next major and above. `vitest` / `@vitest/coverage-v8` / `@types/node`
// are the majors AGENTS.md/CLAUDE.md's "Deliberately held-back majors" bullet
// documents; `typescript` is a different case — see the module doc comment.
const HELD_BACK: ReadonlyArray<{ name: string; heldMajor: number }> = [
	{ name: "vitest", heldMajor: 4 },
	{ name: "@vitest/coverage-v8", heldMajor: 4 },
	{ name: "typescript", heldMajor: 7 },
	{ name: "@types/node", heldMajor: 24 },
];

async function loadDependabotConfig(): Promise<DependabotDoc> {
	const text = await readFile(new URL(".github/dependabot.yml", ROOT), "utf8");
	return parse(text) as DependabotDoc;
}

describe(".github/dependabot.yml (X-15)", () => {
	test("declares every ecosystem this workspace has (anti-false-green)", async () => {
		const doc = await loadDependabotConfig();
		const ecosystems = (doc.updates ?? []).map((u) => u["package-ecosystem"]);

		expect(doc.updates?.length).toBeGreaterThan(0);
		expect(ecosystems).toContain("npm");
		expect(ecosystems).toContain("uv");
		expect(ecosystems).toContain("github-actions");
	});

	test("npm ecosystem ignores exactly the majors held back in package.json", async () => {
		const [doc, packageJsonText] = await Promise.all([
			loadDependabotConfig(),
			readFile(new URL("package.json", ROOT), "utf8"),
		]);
		const packageJson = JSON.parse(packageJsonText) as PackageJson;

		const npmUpdate = doc.updates?.find((u) => u["package-ecosystem"] === "npm");
		expect(npmUpdate).toBeDefined();
		const ignoreByName = new Map(
			(npmUpdate?.ignore ?? []).map((entry) => [entry["dependency-name"], entry.versions ?? []]),
		);

		for (const { name, heldMajor } of HELD_BACK) {
			const declaredRange = packageJson.devDependencies?.[name];
			expect(declaredRange, `${name} must still be a devDependency`).toBeDefined();
			expect(
				declaredRange,
				`package.json's ${name} range must stay on major ${heldMajor} — ` +
					"update this test's HELD_BACK table (and the AGENTS.md/CLAUDE.md bullet) if it changed on purpose",
			).toMatch(new RegExp(`^[~^]?${heldMajor}\\.`));

			const versions = ignoreByName.get(name);
			expect(versions, `dependabot.yml must ignore ${name} >= ${heldMajor + 1}`).toEqual([
				`>=${heldMajor + 1}`,
			]);
		}
	});

	// Dependabot's npm block covers the whole pnpm workspace and cannot scope an
	// `ignore` to one manifest, so the 6.x pin below is the ONLY thing keeping a
	// bot (or a hand edit) from moving packages/schemas to TypeScript 7 — where
	// openapi-typescript stops working entirely, because the 7.x `typescript`
	// package no longer exports the JS compiler API it builds its AST with.
	// contract-drift.spec.ts would then fail on import; this asserts the cause
	// directly so the diagnosis doesn't have to start from that crash.
	test("packages/schemas keeps its own typescript pinned on 6.x for openapi-typescript", async () => {
		const text = await readFile(new URL("packages/schemas/package.json", ROOT), "utf8");
		const manifest = JSON.parse(text) as PackageJson;

		expect(
			manifest.devDependencies?.["openapi-typescript"],
			"openapi-typescript must stay a packages/schemas devDependency (it needs the TS 6 compiler API)",
		).toBeDefined();
		expect(
			manifest.devDependencies?.typescript,
			"packages/schemas must pin typescript on 6.x until openapi-typescript supports TS 7 — " +
				"see the dependabot.yml KNOWN GAP comment and the AGENTS.md TypeScript bullet",
		).toMatch(/^[~^]?6\./);
	});
});
