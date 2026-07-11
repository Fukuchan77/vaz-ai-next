import { createChatAgent } from "@vaz/agents/chat-agent";
import { initTelemetry } from "@vaz/config/telemetry";
import type { AgentDeps } from "@vaz/schemas/deps";
import type { GradeReport } from "@vaz/schemas/eval";
import type { LanguageModel, UIMessage } from "ai";
import type { JudgeToolCall } from "./judge";
import { gradeRun } from "./judge";

/**
 * Tier3 nightly eval (R4.4/4.6): drives the real chat agent (`createChatAgent`,
 * `@vaz/agents`) against a golden set of requests, grades each completed run
 * with the tier3 judge (`gradeRun`, Task 17.3), and enforces a token-based
 * cost cap so a nightly run cannot run away on spend. The cap counts BOTH the
 * driven agent's usage and the judge's own `generateText` usage — grading a
 * run is itself a paid model call, not a free side effect of the run it
 * grades. `eval:nightly` (`packages/evals/package.json`) invokes this
 * module's CLI entrypoint; the `eval-nightly.yml` workflow (Task 17.5) is
 * what gates *when* it runs (GitHub Secrets) and fails CI on whatever this
 * module reports (regression, a failed case, or an all-skipped run).
 *
 * Regression detection (R4.6) is per-case, not a separate diffing step: each
 * `GoldenCase` carries its own baseline (`minOutcomeScore`/`minBehaviorScore`)
 * and a case regresses when the judge's `GradeReport` falls below it —
 * comparable to the RAG `recall@k` golden set (Task 10.2), but scored by the
 * LLM-as-judge instead of embeddings.
 *
 * The cap is checked BEFORE each case runs, not against each case's actual
 * cost as it accrues — so a case that crosses the threshold still runs to
 * completion, and real spend can overshoot `costCapTokens` by up to one
 * case's cost. This bounds the *total* spend to roughly `costCapTokens`, not
 * the case count, and is why `resolveCostCapFromEnv` and `allSkipped` guard
 * against a degenerate cap of `0`/negative turning "nothing ran" into a
 * false-positive clean result.
 */

/** A single nightly golden-set case: a request plus its score baseline. */
export interface GoldenCase {
	readonly id: string;
	readonly request: string;
	readonly minOutcomeScore: number;
	readonly minBehaviorScore: number;
}

/**
 * Default nightly golden set. Deliberately small (unlike the RAG `recall@k`
 * set's 20-50 pairs, R2.5): tier3 runs a real model + a real judge model, so
 * every added case is real spend — the token-based cost cap below bounds the
 * total, not the case count.
 */
export const GOLDEN_SET: readonly GoldenCase[] = [
	{
		id: "current-time",
		request: "今何時か教えて",
		minOutcomeScore: 0.7,
		minBehaviorScore: 0.7,
	},
	{
		id: "platform-summary",
		request: "VAZプラットフォームの構成を一言で教えて",
		minOutcomeScore: 0.6,
		minBehaviorScore: 0.6,
	},
];

/** Default token cap for a full nightly run; overridable via `EVAL_NIGHTLY_COST_CAP_TOKENS`. */
export const DEFAULT_COST_CAP_TOKENS = 50_000;

/** A golden case that ran to completion and was graded. */
export interface GradedCaseResult {
	readonly id: string;
	readonly request: string;
	readonly grade: GradeReport;
	readonly totalTokens: number;
	readonly regressed: boolean;
	readonly skipped: false;
}

/**
 * A golden case that did not run to completion: either the cost cap was
 * already reached (`"cost-cap-exceeded"`), or the run itself threw
 * (`"case-failed"` — a transient provider error, a judge schema rejection,
 * etc). `error` is only present for `"case-failed"`.
 */
export interface SkippedCaseResult {
	readonly id: string;
	readonly request: string;
	readonly skipped: true;
	readonly reason: "cost-cap-exceeded" | "case-failed";
	readonly error?: string;
}

export type NightlyCaseResult = GradedCaseResult | SkippedCaseResult;

/** Aggregate result of a nightly run: per-case results plus cost-cap and regression status. */
export interface NightlyRunSummary {
	readonly results: readonly NightlyCaseResult[];
	readonly totalTokens: number;
	readonly costCapTokens: number;
	readonly costCapExceeded: boolean;
	readonly hasRegression: boolean;
	/** True if any case threw (`"case-failed"`) rather than completing and being graded. */
	readonly hasFailure: boolean;
	/**
	 * True when the golden set was non-empty but every case ended up skipped —
	 * e.g. a misconfigured cost cap reached `0` before the first case could run.
	 * Distinct from `hasRegression`/`hasFailure` because a fully-skipped run
	 * graded nothing at all, which must not read as "no regression found".
	 */
	readonly allSkipped: boolean;
}

export interface RunNightlyEvalOptions {
	readonly deps?: AgentDeps;
	readonly goldenSet?: readonly GoldenCase[];
	readonly costCapTokens?: number;
	/** Test seam, mirrors `createChatAgent`'s `options.model` (ADR-3/R1.6). */
	readonly agentModel?: LanguageModel;
	/** Test seam, mirrors `gradeRun`'s `options.model` (ADR-3/R1.6). */
	readonly judgeModel?: LanguageModel;
}

/** Stateless deps (Phase 1, `db: null`) — the nightly run has no durable job or user. */
function defaultDeps(): AgentDeps {
	return {
		db: null,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		now: () => new Date(),
	};
}

function toUserMessage(goldenCase: GoldenCase): UIMessage[] {
	return [
		{
			id: goldenCase.id,
			role: "user",
			parts: [{ type: "text", text: goldenCase.request }],
		},
	];
}

/**
 * Runs the nightly golden-set eval end to end (R4.4/4.6). In production
 * `agentModel`/`judgeModel` are omitted, so both the driven chat agent and the
 * judge resolve a real model from env (`@vaz/config#resolveModel()`,
 * R1.8/NFR-3 — no model IDs hardcoded here).
 */
export async function runNightlyEval(
	options: RunNightlyEvalOptions = {},
): Promise<NightlyRunSummary> {
	const deps = options.deps ?? defaultDeps();
	const goldenSet = options.goldenSet ?? GOLDEN_SET;
	const costCapTokens = options.costCapTokens ?? DEFAULT_COST_CAP_TOKENS;
	const agent = createChatAgent(deps, { model: options.agentModel });

	let totalTokens = 0;
	const results: NightlyCaseResult[] = [];

	for (const goldenCase of goldenSet) {
		if (totalTokens >= costCapTokens) {
			results.push({
				id: goldenCase.id,
				request: goldenCase.request,
				skipped: true,
				reason: "cost-cap-exceeded",
			});
			continue;
		}

		try {
			const runResult = await agent.stream({ messages: toUserMessage(goldenCase) });
			const [finalOutput, toolCalls, usage] = await Promise.all([
				runResult.text,
				runResult.toolCalls,
				runResult.usage,
			]);

			const { report: grade, usage: judgeUsage } = await gradeRun(
				{
					request: goldenCase.request,
					toolCalls: toolCalls.map(
						(call): JudgeToolCall => ({ toolName: call.toolName, input: call.input }),
					),
					finalOutput,
				},
				{ model: options.judgeModel },
			);

			// Grading is itself a paid model call — count the judge's usage too, not
			// just the driven agent's, or the cap silently ignores roughly half the spend.
			const caseTokens = (usage.totalTokens ?? 0) + (judgeUsage.totalTokens ?? 0);
			totalTokens += caseTokens;

			const regressed =
				grade.outcome.score < goldenCase.minOutcomeScore ||
				grade.behavior.score < goldenCase.minBehaviorScore;

			results.push({
				id: goldenCase.id,
				request: goldenCase.request,
				grade,
				totalTokens: caseTokens,
				regressed,
				skipped: false,
			});
		} catch (error) {
			// A transient provider error or a judge schema rejection must not abort
			// the whole run — record it and let the remaining cases still get a chance.
			results.push({
				id: goldenCase.id,
				request: goldenCase.request,
				skipped: true,
				reason: "case-failed",
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		results,
		totalTokens,
		costCapTokens,
		costCapExceeded: totalTokens >= costCapTokens,
		hasRegression: results.some((result) => !result.skipped && result.regressed),
		hasFailure: results.some((result) => result.skipped && result.reason === "case-failed"),
		allSkipped: results.length > 0 && results.every((result) => result.skipped),
	};
}

/**
 * Parses `EVAL_NIGHTLY_COST_CAP_TOKENS`. Non-positive values (`"0"`, negative)
 * are treated the same as unset — falling through to `DEFAULT_COST_CAP_TOKENS`
 * — rather than honored literally: a cap of `0` would make `runNightlyEval`
 * skip every case before the first one runs (see `allSkipped`), which reads as
 * a clean, non-regressed run rather than the misconfiguration it actually is.
 */
export function resolveCostCapFromEnv(env: Record<string, string | undefined>): number | undefined {
	const raw = env.EVAL_NIGHTLY_COST_CAP_TOKENS;
	if (!raw) {
		return undefined;
	}
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) || parsed <= 0 ? undefined : parsed;
}

/**
 * CLI entrypoint (`eval:nightly` in `package.json`). Initializes telemetry
 * first (`@vaz/config#initTelemetry`, mirrors `apps/web/instrumentation.ts`)
 * so every `generateText`/`streamText` call this run makes — both the driven
 * agent and the judge — emits OTel spans that export to Langfuse when
 * configured (fail-soft otherwise, R4.1/4.3/NFR-7); this is how a nightly
 * run's results are recorded to Langfuse, reusing the existing pipeline
 * rather than a bespoke client. Exits non-zero when a regression is detected,
 * a case failed to run, or the run skipped every case (R4.6) so
 * `eval-nightly.yml` (Task 17.5) can fail CI on any of them.
 */
async function main(): Promise<void> {
	initTelemetry();
	const costCapTokens = resolveCostCapFromEnv(process.env);
	const summary = await runNightlyEval(costCapTokens === undefined ? {} : { costCapTokens });

	console.log(JSON.stringify(summary, null, 2));

	if (summary.hasRegression) {
		console.error("[eval:nightly] score regression detected against the golden-set baseline.");
		process.exitCode = 1;
	}
	if (summary.hasFailure) {
		console.error("[eval:nightly] one or more golden-set cases failed to run.");
		process.exitCode = 1;
	}
	if (summary.allSkipped) {
		console.error(
			"[eval:nightly] every golden-set case was skipped before it could run " +
				"(cost cap reached with zero spend) — this run validated nothing.",
		);
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error("[eval:nightly] run failed:", error);
		process.exitCode = 1;
	});
}
