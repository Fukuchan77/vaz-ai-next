import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

/**
 * End-to-end proof that a PDF ingested via `--via-parser` surfaces a
 * `locator` in a chat citation (Req 4.5).
 *
 * Round trip: build a minimal synthetic PDF (no fixture checked into git —
 * see below) → ingest it through `packages/rag/bin/ingest.ts --via-parser`
 * (real `services/agent` `/parse` call + the existing embed+upsert path) →
 * ask the running chat app a question only the ingested document can answer
 * → assert the `searchDocuments` tool's rendered output contains `"locator"`.
 *
 * Run conditions (auto-skipped when unmet, so default `mise run test:e2e`
 * stays green):
 * - `DATABASE_URL` set (reachable PostgreSQL + pgvector, e.g. `docker compose
 *   up -d db`)
 * - `AGENT_SERVICE_URL` set and reachable (`cd services/agent && uv sync &&
 *   uv run uvicorn app.main:app --port 8000`; heavy — pulls in Docling/torch)
 * - The embedding provider (Ollama `nomic-embed-text` by default) reachable
 * - The active chat provider configured/reachable — mirrors the split in
 *   `chat-anthropic.spec.ts` (`ANTHROPIC_API_KEY`) / `chat-ollama.spec.ts`
 *   (`AI_PROVIDER=ollama` + model pulled), so this spec runs under whichever
 *   provider the local stack is already configured for.
 *
 * Example: `DATABASE_URL=postgres://vaz:vaz@localhost:5432/vaz
 * AGENT_SERVICE_URL=http://localhost:8000 ANTHROPIC_API_KEY=… mise run test:e2e`
 *
 * No PDF fixture is checked into the repo: {@link buildMinimalPdf} hand-rolls
 * a spec-valid single-page PDF (header/objects/xref/trailer) at runtime, so
 * the corpus content stays diffable/auditable as code rather than an opaque
 * binary blob (there is no existing convention for binary test fixtures in
 * this repo).
 */

const execFileAsync = promisify(execFile);

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL ?? "http://localhost:8000";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const EMBEDDING_MODEL = process.env.AI_EMBEDDING_MODEL ?? "nomic-embed-text";

// `process.cwd()` (not `import.meta.url`) — Playwright's CJS test transform breaks on
// `import.meta` under this workspace's ESM packages ("require is not defined in ES
// module scope"); `pnpm exec playwright test` / `mise run test:e2e` always run from
// the repo root (see `playwright.config.ts`'s `webServer.command`), so this is stable.
const RAG_PACKAGE_DIR = join(process.cwd(), "packages/rag");

const CODENAME = "Nightjar-19";
// The codename must not sit at the end of the PDF's text line: Docling's OCR
// path clipped trailing characters of the synthetic page ("19." was lost,
// 003 pdca/check.md), so a sacrificial sentence follows it — line-end loss
// eats the sentinel, never the fact under test.
const DISTINCTIVE_FACT =
	`The internal project codename for the Q3 filing overhaul is ${CODENAME}. ` +
	"File this brief under the quarterly compliance notes.";

/**
 * Builds a minimal, spec-valid single-page PDF whose sole text content is
 * `text` (no external dependency — every object offset is computed inline).
 * Docling extracts this as one page-anchored chunk, giving `/parse` a real
 * `locator` (page→section→char) to return.
 */
function buildMinimalPdf(text: string): Buffer {
	const escaped = text.replace(/([()\\])/g, "\\$1");
	const content = `BT /F1 18 Tf 72 700 Td (${escaped}) Tj ET`;
	const objectBodies = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
			"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
	];

	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (const [index, objectBody] of objectBodies.entries()) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += `${index + 1} 0 obj\n${objectBody}\nendobj\n`;
	}

	const xrefOffset = Buffer.byteLength(body, "latin1");
	const entryCount = objectBodies.length + 1;
	let xref = `xref\n0 ${entryCount}\n0000000000 65535 f \n`;
	for (const offset of offsets) {
		xref += `${offset.toString().padStart(10, "0")} 00000 n \n`;
	}
	body += xref;
	body += `trailer\n<< /Size ${entryCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

	return Buffer.from(body, "latin1");
}

/** Reachability probe with a short timeout, mirroring `chat-ollama.spec.ts`'s house pattern. */
async function isReachable(url: string, timeoutMs = 2_000): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
		return res.ok;
	} catch {
		return false;
	}
}

/** True only when Ollama is reachable AND `model` is actually pulled (same check as `chat-ollama.spec.ts`). */
async function ollamaModelAvailable(model: string): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_BASE_URL}/models`, { signal: AbortSignal.timeout(2_000) });
		if (!res.ok) return false;
		const body = (await res.json()) as { data?: Array<{ id?: string }> };
		const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
		const base = model.split(":")[0];
		return ids.some((id) => id === model || id.split(":")[0] === base);
	} catch {
		return false;
	}
}

/** Whether the currently configured chat provider is ready, mirroring the split anthropic/ollama gate. */
async function chatProviderReady(): Promise<{ ready: boolean; reason: string }> {
	if (process.env.AI_PROVIDER === "ollama") {
		const model = process.env.OLLAMA_MODEL ?? "llama3.2";
		const ready = await ollamaModelAvailable(model);
		return { ready, reason: `${model} unavailable on Ollama at ${OLLAMA_BASE_URL}` };
	}
	const ready = Boolean(process.env.ANTHROPIC_API_KEY);
	return { ready, reason: "AI_PROVIDER=anthropic (default) requires ANTHROPIC_API_KEY" };
}

test.describe("PDF ingested via --via-parser surfaces a locator in chat citations (Req 4.5)", () => {
	const databaseUrl = process.env.DATABASE_URL;
	test.skip(
		!databaseUrl || !process.env.AGENT_SERVICE_URL,
		"runs only when DATABASE_URL and AGENT_SERVICE_URL are set (local stack)",
	);

	test("ingesting a PDF through services/agent makes its citation include a locator", async ({
		page,
	}) => {
		test.setTimeout(600_000);

		const agentUp = await isReachable(`${AGENT_SERVICE_URL}/healthz`);
		test.skip(
			!agentUp,
			`services/agent unreachable at ${AGENT_SERVICE_URL} (start with ` +
				"`uv run uvicorn app.main:app --port 8000` in services/agent)",
		);

		const embeddingUp = await ollamaModelAvailable(EMBEDDING_MODEL);
		test.skip(!embeddingUp, `${EMBEDDING_MODEL} unavailable on Ollama at ${OLLAMA_BASE_URL}`);

		const provider = await chatProviderReady();
		test.skip(!provider.ready, provider.reason);

		const corpusDir = await mkdtemp(join(tmpdir(), "locator-citation-"));
		try {
			await writeFile(join(corpusDir, "nightjar-brief.pdf"), buildMinimalPdf(DISTINCTIVE_FACT));

			await execFileAsync("node", ["bin/ingest.ts", "--via-parser", corpusDir], {
				cwd: RAG_PACKAGE_DIR,
				env: { ...process.env, DATABASE_URL: databaseUrl },
				timeout: 480_000,
			});

			await page.goto("/");
			await page
				.getByPlaceholder(/メッセージを入力/)
				.fill(
					"According to our internal documents, what is the internal project codename " +
						"for the Q3 filing overhaul? Cite your source.",
				);
			await page.getByRole("button", { name: "送信" }).click();

			// exact: true — the reply text can contain the substring "You", which
			// makes the bare getByText("You") a strict-mode ambiguous match
			// (003 pdca/check.md); only the <strong> role label is exactly "You".
			await expect(page.getByText("You", { exact: true })).toBeVisible();

			const toolOutput = page.locator('[class*="toolOutput"]').filter({ hasText: CODENAME });
			await expect(toolOutput.first()).toBeVisible({ timeout: 150_000 });
			await expect(toolOutput.first()).toContainText('"locator"');
		} finally {
			await rm(corpusDir, { recursive: true, force: true });
		}
	});
});
