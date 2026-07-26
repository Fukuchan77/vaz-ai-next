import type { AgentDeps } from "@vaz/schemas/deps";
import type { Citation } from "@vaz/schemas/rag";
import type { JobEvent, SpecialistInput, SupervisorPlan } from "@vaz/schemas/workflows";
import {
	checkDocumentMechanically,
	createSupervisorWorkflow,
	DocumentVerificationError,
	type DocumentVerificationInput,
	type SpecialistRegistry,
} from "../src/supervisor";

/**
 * Unit tests for the supervisor's optional doc-gen verification step
 * (Doer-Verifier, RV-7 / Req 5.5-5.7). Pins the three behaviors task 11.1
 * requires:
 *   (a) unset `verifyDocument` → existing behavior is byte-for-byte unchanged.
 *   (b) a configured `llmVerify` receives ONLY `{ document, acceptanceCriteria }`
 *       — never the doer's conversation history.
 *   (c) a verification failure emits a `JobEvent` using the closed vocabulary
 *       established by Req 1.4/1.5 (`RunStopReason`'s `"error"`), not a
 *       bespoke ad-hoc string.
 */

const PINNED = new Date("2026-02-03T04:05:06.000Z");
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const makeDeps = (overrides: Partial<AgentDeps> = {}): AgentDeps =>
	({ db: null, logger: silentLogger, now: () => PINNED, ...overrides }) as AgentDeps;

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DOC_ID = "11111111-1111-4111-8111-111111111111";
const CHUNK_ID = "22222222-2222-4222-8222-222222222222";
const CIT: Citation = { documentId: DOC_ID, source: "docs/a.md", chunkId: CHUNK_ID };

const docGenStep = (
	stepId: string,
	instructions: string,
	extra: Partial<Extract<SpecialistInput, { kind: "document-generation" }>> = {},
) => ({
	stepId,
	task: {
		kind: "document-generation" as const,
		instructions,
		format: "markdown" as const,
		...extra,
	} satisfies SpecialistInput,
});

const passingSpecialists = (
	content = "docs/a.md によれば本文の内容です。",
): Partial<SpecialistRegistry> => ({
	"document-generation": async (task) => ({
		kind: "document-generation",
		document: { title: "T", format: task.format, content },
	}),
});

describe("supervisor doc-gen verification — unset (Req 5.5 default unchanged)", () => {
	test("does not call a would-be verifier or alter events when `verifyDocument` is omitted", async () => {
		const events: JobEvent[] = [];
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [docGenStep(S1, "write", { citations: [CIT] })],
		};

		// No `verifyDocument` option at all — the option is entirely absent, not merely falsy.
		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists: passingSpecialists("this document mentions nothing about any citation"),
			emit: (e) => {
				events.push(e);
			},
		});
		const results = await wf.dispatch(plan, { jobId: JOB });

		// A mechanical check would have failed this content (no citation referenced) —
		// proving it never ran because verification is unconfigured.
		expect(events.map((e) => e.type)).toEqual(["step-start", "completion", "completion"]);
		expect(results[0]?.result.kind).toBe("document-generation");
	});
});

describe("supervisor doc-gen verification — llmVerify input shape (Req 5.6)", () => {
	test("receives only { document, acceptanceCriteria } — no citations, jobId, or other context", async () => {
		let received: DocumentVerificationInput | undefined;
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [docGenStep(S1, "write the onboarding guide", { citations: [CIT] })],
		};

		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists: passingSpecialists(),
			verifyDocument: {
				llmVerify: async (input) => {
					received = input;
					return { passed: true };
				},
			},
		});
		await wf.dispatch(plan, { jobId: JOB });

		expect(received).toEqual({
			document: { title: "T", format: "markdown", content: "docs/a.md によれば本文の内容です。" },
			acceptanceCriteria: "write the onboarding guide",
		});
		// Exactly two keys — no leaked `citations`/`jobId`/`instructions`/conversation fields.
		expect(Object.keys(received ?? {}).sort()).toEqual(["acceptanceCriteria", "document"]);
	});

	test("skips llmVerify entirely when the mechanical check already failed", async () => {
		let called = false;
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [docGenStep(S1, "write", { citations: [CIT] })],
		};

		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists: passingSpecialists(""), // empty content fails the mechanical check
			verifyDocument: {
				llmVerify: async () => {
					called = true;
					return { passed: true };
				},
			},
		});

		await expect(wf.dispatch(plan, { jobId: JOB })).rejects.toBeInstanceOf(
			DocumentVerificationError,
		);
		expect(called).toBe(false);
	});

	test("mechanical-only mode (no llmVerify) still enforces the check when verifyDocument is configured", async () => {
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [docGenStep(S1, "write", { citations: [CIT] })],
		};

		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists: passingSpecialists("this document mentions nothing about any citation"),
			verifyDocument: {},
		});

		await expect(wf.dispatch(plan, { jobId: JOB })).rejects.toBeInstanceOf(
			DocumentVerificationError,
		);
	});
});

describe("supervisor doc-gen verification — failure emits closed-vocabulary JobEvent (Req 5.7)", () => {
	test('a rejected llmVerify verdict emits an `error` JobEvent whose code is RunStopReason\'s "error", and rejects', async () => {
		const events: JobEvent[] = [];
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [docGenStep(S1, "write", { citations: [CIT] })],
		};

		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists: passingSpecialists(),
			verifyDocument: {
				llmVerify: async () => ({ passed: false, reason: "hallucinated claim" }),
			},
			emit: (e) => {
				events.push(e);
			},
		});

		await expect(wf.dispatch(plan, { jobId: JOB })).rejects.toBeInstanceOf(
			DocumentVerificationError,
		);

		const errEvent = events.find((e) => e.type === "error");
		expect(errEvent).toMatchObject({
			type: "error",
			stepId: S1,
			jobId: JOB,
			code: "error", // RunStopReason's closed vocabulary (Req 1.4), not an ad-hoc string
		});
		expect(errEvent?.type === "error" && errEvent.message).toContain("hallucinated claim");
		// A failed verification never publishes that step's completion.
		expect(events.some((e) => e.type === "completion")).toBe(false);
	});

	test("a mechanical-check failure (citations supplied but never referenced) also emits the same closed-vocabulary error", async () => {
		const events: JobEvent[] = [];
		const plan: SupervisorPlan = {
			goal: "g",
			steps: [docGenStep(S1, "write", { citations: [CIT] })],
		};

		const wf = createSupervisorWorkflow(makeDeps(), {
			specialists: passingSpecialists("this document mentions nothing about any citation"),
			verifyDocument: {},
			emit: (e) => {
				events.push(e);
			},
		});

		await expect(wf.dispatch(plan, { jobId: JOB })).rejects.toBeInstanceOf(
			DocumentVerificationError,
		);
		const errEvent = events.find((e) => e.type === "error");
		expect(errEvent).toMatchObject({ type: "error", stepId: S1, code: "error" });
	});
});

describe("checkDocumentMechanically (Req 5.5 — citation-reference existence + format conformance)", () => {
	test("fails on empty content", () => {
		expect(
			checkDocumentMechanically({ title: "t", format: "markdown", content: "  " }, []),
		).toEqual({
			passed: false,
			reason: "document content is empty",
		});
	});

	test("fails when citations were supplied but none are referenced in the content", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "markdown", content: "unrelated text" },
			[CIT],
		);
		expect(result.passed).toBe(false);
	});

	test("passes when at least one supplied citation's source is referenced", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "markdown", content: `see ${CIT.source} for details` },
			[CIT],
		);
		expect(result).toEqual({ passed: true });
	});

	test("passes with no citations supplied at all (nothing to cross-check)", () => {
		expect(
			checkDocumentMechanically({ title: "t", format: "markdown", content: "plain text" }, []),
		).toEqual({
			passed: true,
		});
	});

	test("fails html format with no HTML markup", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "html", content: "plain text" },
			[],
		);
		expect(result.passed).toBe(false);
	});

	test("passes html format with HTML markup", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "html", content: "<p>plain text</p>" },
			[],
		);
		expect(result).toEqual({ passed: true });
	});

	test("fails plaintext format that contains HTML markup", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "plaintext", content: "<p>not plain</p>" },
			[],
		);
		expect(result.passed).toBe(false);
	});

	test("fails plaintext format that contains a self-closing HTML tag", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "plaintext", content: "line one<br/>line two" },
			[],
		);
		expect(result.passed).toBe(false);
	});

	// A single `<word>`-shaped token also matches ordinary prose (generics,
	// chained comparisons) — must not false-reject a genuine plaintext document.
	test("passes plaintext format containing a generic type annotation (not HTML)", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "plaintext", content: "Use a List<String> to hold the results." },
			[],
		);
		expect(result).toEqual({ passed: true });
	});

	test("passes plaintext format containing chained comparison operators (not HTML)", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "plaintext", content: "The rule applies when a<b and c>d." },
			[],
		);
		expect(result).toEqual({ passed: true });
	});

	// Many unmatched open tags with no close is the pathological input the linear
	// two-scan detector replaced a backtracking `<tag>…</tag>` regex to handle:
	// it must resolve quickly to "no matched pair" (plaintext OK), not stall.
	test("passes plaintext format with many unmatched open-tag-shaped tokens (no matched pair)", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "plaintext", content: `${"<p x>".repeat(5000)}tail` },
			[],
		);
		expect(result).toEqual({ passed: true });
	});

	// A close preceding its only open is not an in-order pair — not HTML markup.
	test("passes plaintext format where a close tag precedes its matching open", () => {
		const result = checkDocumentMechanically(
			{ title: "t", format: "plaintext", content: "</p> then later <p> opens" },
			[],
		);
		expect(result).toEqual({ passed: true });
	});
});
