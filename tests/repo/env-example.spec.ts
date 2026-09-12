import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * `.env.example` drift guard (spec 005 task 4.7, deferred at the time because
 * the file was unreadable under the agent's permission config).
 *
 * `.env.example` is the only catalogue of this workspace's environment
 * variables, and it has drifted twice: once from 5 keys to the 19 the code
 * read, and again when `TOOL_APPROVAL_SECRET` was added for R5.6 approval
 * signing without a matching entry. Nothing failed either time. This test
 * closes the loop in both directions:
 *
 *   - every `env.SCREAMING_CASE` read in non-test `apps/**` / `packages/**`
 *     source must have an entry in `.env.example`;
 *   - every entry in `.env.example` must be either such a read or listed in
 *     {@link EXTERNALLY_READ} below — so a key that stops being used, or one
 *     read by an SDK/compose rather than by our code, has to be accounted for
 *     deliberately rather than accumulating unexplained.
 *
 * The scan asserts it visited a non-zero number of files and found a non-zero
 * number of keys (X-3 anti-false-green: a broken glob must fail loudly instead
 * of vacuously passing).
 */

const ROOT = new URL("../../", import.meta.url);

/** `env.FOO` / `process.env.FOO` — the shape every env read in this repo takes. */
const ENV_READ = /\benv\.([A-Z][A-Z0-9_]{2,})\b/g;

/**
 * Keys that legitimately live in `.env.example` without appearing as an
 * `env.X` read in our own source. Each is consumed by something outside the
 * workspace's TypeScript, so grep cannot find it.
 */
const EXTERNALLY_READ: ReadonlyMap<string, string> = new Map([
	// `@ai-sdk/anthropic`'s `createAnthropic()` falls back to this itself;
	// `@vaz/config`'s `resolveModel` never touches it (only the provider/model
	// enums come through `parseAiEnv`), so it is invisible to the scan.
	["ANTHROPIC_API_KEY", "@ai-sdk/anthropic + docker-compose.yml"],
	// Auth.js discovers OAuth client credentials by naming convention
	// (apps/web/src/lib/auth.ts passes only the Entra ID issuer explicitly).
	["AUTH_MICROSOFT_ENTRA_ID_ID", "Auth.js naming convention"],
	["AUTH_MICROSOFT_ENTRA_ID_SECRET", "Auth.js naming convention"],
	["AUTH_GOOGLE_ID", "Auth.js naming convention"],
	["AUTH_GOOGLE_SECRET", "Auth.js naming convention"],
	// Read by the Inngest SDK inside `new InngestClient()`, not by us
	// (apps/worker/src/inngest.ts documents this).
	["INNGEST_BASE_URL", "Inngest SDK"],
	["INNGEST_DEV", "Inngest SDK"],
	["INNGEST_EVENT_KEY", "Inngest SDK + docker-compose.yml"],
	["INNGEST_SIGNING_KEY", "Inngest SDK + docker-compose.yml"],
	// docker-compose.yml `${...}` interpolation only.
	["POSTGRES_USER", "docker-compose.yml"],
	["POSTGRES_PASSWORD", "docker-compose.yml"],
	["POSTGRES_DB", "docker-compose.yml"],
	["POSTGRES_PORT", "docker-compose.yml"],
	["REDIS_PORT", "docker-compose.yml"],
	["INNGEST_PORT", "docker-compose.yml"],
	["INNGEST_CONNECT_PORT", "docker-compose.yml"],
	["AGENT_SERVICE_PORT", "docker-compose.yml"],
	// services/agent's pydantic-settings maps snake_case fields to these
	// (services/agent/app/config.py).
	["JUDGE_PROVIDER", "services/agent pydantic-settings"],
	["JUDGE_MODEL", "services/agent pydantic-settings"],
	["LLAMAPARSE_API_KEY", "services/agent pydantic-settings"],
]);

/** Provided by the runtime/CI, never by a dotenv file. */
const RUNTIME_PROVIDED = new Set(["NODE_ENV", "CI", "VITEST", "TZ", "PATH", "HOME"]);

const SCAN_ROOTS = ["apps", "packages"];

function isScannable(path: string): boolean {
	if (!/\.tsx?$/.test(path)) return false;
	if (/\.(spec|test)\.tsx?$/.test(path)) return false;
	if (path.includes("/tests/")) return false;
	if (path.includes("/src/generated/")) return false;
	if (path.includes("/node_modules/")) return false;
	return true;
}

async function collectSourceFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const root of SCAN_ROOTS) {
		const dir = fileURLToPath(new URL(root, ROOT));
		const entries = await readdir(dir, { recursive: true, withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const full = `${entry.parentPath}/${entry.name}`;
			if (isScannable(full)) files.push(full);
		}
	}
	return files;
}

async function collectEnvReads(): Promise<{ keys: Set<string>; fileCount: number }> {
	const files = await collectSourceFiles();
	const keys = new Set<string>();
	for (const file of files) {
		const text = await readFile(file, "utf8");
		for (const match of text.matchAll(ENV_READ)) {
			const key = match[1];
			if (key != null && !RUNTIME_PROVIDED.has(key)) keys.add(key);
		}
	}
	return { keys, fileCount: files.length };
}

/** Keys declared as an assignable `KEY=` line — prose mentions don't count. */
async function collectExampleKeys(): Promise<Set<string>> {
	const text = await readFile(new URL(".env.example", ROOT), "utf8");
	const keys = new Set<string>();
	for (const line of text.split("\n")) {
		const match = /^([A-Z][A-Z0-9_]{2,})=/.exec(line);
		if (match?.[1] != null) keys.add(match[1]);
	}
	return keys;
}

describe(".env.example", () => {
	test("the source scan is not vacuous", async () => {
		const { keys, fileCount } = await collectEnvReads();
		expect(fileCount, "scanned no source files — the glob is broken").toBeGreaterThan(50);
		expect(keys.size, "found no env reads — the ENV_READ pattern is broken").toBeGreaterThan(15);
	});

	test("documents every env var the code reads", async () => {
		const { keys } = await collectEnvReads();
		const example = await collectExampleKeys();
		const missing = [...keys].filter((key) => !example.has(key)).sort();
		expect(
			missing,
			"read from env but absent from .env.example — add a `KEY=` entry with the " +
				"defaulting/required behaviour, as it is the only catalogue of these",
		).toEqual([]);
	});

	test("documents nothing the code no longer reads", async () => {
		const { keys } = await collectEnvReads();
		const example = await collectExampleKeys();
		const orphans = [...example]
			.filter((key) => !keys.has(key) && !EXTERNALLY_READ.has(key))
			.sort();
		expect(
			orphans,
			"present in .env.example but read by nothing — delete the entry, or add it to " +
				"EXTERNALLY_READ with the consumer that does read it",
		).toEqual([]);
	});

	test("EXTERNALLY_READ has no stale entries of its own", async () => {
		const example = await collectExampleKeys();
		const stale = [...EXTERNALLY_READ.keys()].filter((key) => !example.has(key)).sort();
		expect(stale, "listed as externally read but no longer in .env.example").toEqual([]);
	});

	test("carries the R5.6 approval signing key and its AUTH_SECRET fallback", async () => {
		// Specifically pinned: this pair is what makes the HITL approval gate
		// non-decorative, and its absence is exactly the drift that motivated
		// this file. `.env.example` must show both, unset (a shipped default
		// would be a shared public secret, which verifies nothing).
		const text = await readFile(new URL(".env.example", ROOT), "utf8");
		expect(text).toMatch(/^TOOL_APPROVAL_SECRET=$/m);
		expect(text).toMatch(/^AUTH_SECRET=$/m);
	});
});
