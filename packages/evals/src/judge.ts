import { resolveModel } from "@vaz/config/provider";
import type { GradeReport } from "@vaz/schemas/eval";
import { gradeReportSchema } from "@vaz/schemas/eval";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { generateText, Output } from "ai";

/**
 * Tier3 LLM-as-judge (R4.4/4.5): grades a completed agent run against the
 * `GradeReport` contract (`@vaz/schemas/eval`) — outcome (final artifact) and
 * behavior (tool-use process) scored on independent axes by a real model.
 *
 * `options.model` is the same test seam `createChatAgent` uses (`@vaz/agents`
 * ADR-3/R1.6): unit tests inject `MockLanguageModelV4` so the grading wiring
 * itself is exercised with no network; production/nightly callers
 * (`nightly.ts`) omit it and the judge model resolves from env via
 * `@vaz/config#resolveModel()` (R1.8/NFR-3 — no model IDs hardcoded here).
 * Which harness discovers/runs the golden set (evalite vs promptfoo, ADR-4 in
 * research.md) is a separate decision — `gradeRun` only grades a single
 * already-completed run and stays framework-agnostic.
 */

/** A single tool invocation in the graded run, in call order. */
export interface JudgeToolCall {
	toolName: string;
	input: unknown;
}

/** The completed run to grade: the request, the tool-call trace, and the final answer. */
export interface JudgeRunTrace {
	request: string;
	toolCalls: JudgeToolCall[];
	finalOutput: string;
}

export interface GradeRunOptions {
	model?: LanguageModel;
}

/**
 * `gradeRun`'s result: the `GradeReport` plus the judge call's own token
 * usage. The usage is surfaced (not just the report) so callers like
 * `nightly.ts`'s cost cap can account for the judge's real spend — grading a
 * run is itself a paid model call, not a free side effect of the run it grades.
 */
export interface GradeRunResult {
	readonly report: GradeReport;
	readonly usage: LanguageModelUsage;
}

/**
 * Renders `trace` into the judge's grading prompt. Exported so the prompt
 * content itself — not just the schema wiring — is unit-testable.
 */
export function buildJudgePrompt(trace: JudgeRunTrace): string {
	const toolCallLines =
		trace.toolCalls.length > 0
			? trace.toolCalls
					.map((call, i) => `${i + 1}. ${call.toolName}(${JSON.stringify(call.input)})`)
					.join("\n")
			: "(no tool calls)";

	return [
		"You are grading a completed AI agent run on two independent axes.",
		"",
		"outcome: does the final answer satisfy the user's request? Score how well",
		"the final artifact resolves the brief, independent of how it was produced.",
		"",
		"behavior: was the process appropriate? Score whether the agent used the",
		"right tools, in a sensible order, with no unsafe or needless steps —",
		"independent of whether the final answer happens to be correct.",
		"",
		"Each axis is a score in [0, 1] with a non-empty rationale.",
		"",
		`User request:\n${trace.request}`,
		"",
		`Tool calls (in order):\n${toolCallLines}`,
		"",
		`Final output:\n${trace.finalOutput}`,
	].join("\n");
}

/** Grades `trace` against the `GradeReport` contract (R4.5) using a real (or injected) model. */
export async function gradeRun(
	trace: JudgeRunTrace,
	options: GradeRunOptions = {},
): Promise<GradeRunResult> {
	const { output, usage } = await generateText({
		model: options.model ?? resolveModel(),
		output: Output.object({ schema: gradeReportSchema }),
		prompt: buildJudgePrompt(trace),
	});
	return { report: output, usage };
}
