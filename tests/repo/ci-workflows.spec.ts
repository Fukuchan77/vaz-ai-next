import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";

/**
 * X-1 guard: every `.github/workflows/*.yml` `uses:` reference must be pinned to a
 * 40-hex-char commit SHA (never a mutable tag/branch), and every workflow must
 * declare its own `permissions:` block rather than relying on the org/repo
 * default (which can be `write-all`). Modeled on
 * `fastapi-pydantic-ai-agent/tests/unit/test_ci_workflows.py`, the sibling repo
 * this repo scored 0/22 and 0/6 against in the cross-repo review (docs/cross-repo-adoption-backlog.md, X-1).
 */

const WORKFLOWS_DIR = new URL("../../.github/workflows/", import.meta.url);
const SHA_PIN = /^[^@]+@[0-9a-f]{40}$/;

interface WorkflowStep {
	uses?: string;
}

interface WorkflowJob {
	steps?: WorkflowStep[];
	permissions?: unknown;
}

interface WorkflowDoc {
	permissions?: unknown;
	jobs?: Record<string, WorkflowJob>;
}

async function loadWorkflows(): Promise<Array<{ file: string; doc: WorkflowDoc }>> {
	const entries = await readdir(WORKFLOWS_DIR);
	const files = entries.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
	return Promise.all(
		files.map(async (file) => {
			const text = await readFile(new URL(file, WORKFLOWS_DIR), "utf8");
			return { file, doc: parse(text) as WorkflowDoc };
		}),
	);
}

describe("GitHub Actions workflow hygiene (X-1)", () => {
	test("scans at least one workflow file (anti-false-green)", async () => {
		const workflows = await loadWorkflows();
		expect(workflows.length).toBeGreaterThan(0);
	});

	test("every `uses:` step reference is pinned to a commit SHA", async () => {
		const workflows = await loadWorkflows();
		const unpinned: string[] = [];
		let scannedUses = 0;

		for (const { file, doc } of workflows) {
			for (const [jobId, job] of Object.entries(doc.jobs ?? {})) {
				for (const step of job.steps ?? []) {
					if (!step.uses) continue;
					scannedUses += 1;
					if (!SHA_PIN.test(step.uses)) {
						unpinned.push(`${file}#${jobId}: ${step.uses}`);
					}
				}
			}
		}

		expect(scannedUses).toBeGreaterThan(0);
		expect(unpinned).toEqual([]);
	});

	test("every workflow declares its own `permissions:` block", async () => {
		const workflows = await loadWorkflows();
		const missing = workflows
			.filter(({ doc }) => doc.permissions === undefined)
			.map(({ file }) => file);

		expect(missing).toEqual([]);
	});
});
