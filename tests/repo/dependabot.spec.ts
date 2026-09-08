import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/**
 * X-15 guard: `.github/dependabot.yml` must exist, cover every ecosystem this
 * workspace actually has (npm/pnpm workspace, the uv-managed Python sidecar,
 * GitHub Actions), and keep its `ignore:` list for the npm ecosystem in sync
 * with the 3 majors AGENTS.md/CLAUDE.md record as deliberately held back —
 * so a bump to one of those ranges in root `package.json` doesn't silently
 * leave a stale (or missing) `ignore:` entry behind. Modeled on
 * `fastapi-pydantic-ai-agent/tests/unit/test_dependabot_config.py`
 * (docs/cross-repo-adoption-backlog.md, X-15).
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

// Deliberately-held-back majors (AGENTS.md / CLAUDE.md): package.json pins the
// range below; dependabot.yml must ignore the next major and above.
const HELD_BACK: ReadonlyArray<{ name: string; heldMajor: number }> = [
	{ name: "vitest", heldMajor: 4 },
	{ name: "@vitest/coverage-v8", heldMajor: 4 },
	{ name: "typescript", heldMajor: 6 },
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
});
