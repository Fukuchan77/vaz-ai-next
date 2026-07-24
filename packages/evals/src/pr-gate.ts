import { readFileSync, writeFileSync } from "node:fs";
import { initTelemetry } from "@vaz/config/telemetry";
import type { GradedCaseResult, NightlyCaseResult } from "./nightly";
import { GOLDEN_SET, resolveCostCapFromEnv, runNightlyEval } from "./nightly";
import { resolveTier2BaseUrlFromEnv } from "./tier2";

/**
 * PR-gate metrics (Req 5.3/5.4). `computePrGateMetrics` is the pure function
 * whose semantics are locked by `tests/pr-gate.spec.ts` (Task 10.1) — see that
 * file's module doc for the full rationale behind each metric. This module
 * adds only what the spec file doesn't already own: the CLI wrapper
 * (`runPrGate`/`main`) that drives a real `runNightlyEval()` run, times it,
 * and diffs it against a baseline sample read from disk.
 *
 * Baseline persistence deliberately stays file-based and mechanism-agnostic
 * here (`baselinePath`/`outputPath` are plain fs paths) — how a baseline file
 * survives between CI runs (GitHub Actions cache keyed off the default
 * branch, an uploaded artifact, etc.) is `eval-pr.yml`'s concern (Task 10.3),
 * not this module's. A missing/unreadable baseline file is treated the same
 * as "no baseline" rather than a hard failure, since the very first PR-gate
 * run on a repo (or the first run after a cache eviction) has nothing to
 * diff against yet.
 */

export const PR_GATE_MIN_CASES_FOR_BLOCKING = 20;

/** One run's results plus the one thing `NightlyRunSummary` doesn't track: wall-clock duration. */
export interface PrGateRunSample {
	readonly results: readonly NightlyCaseResult[];
	readonly totalDurationMs: number;
}

/** Per-case average cost (tokens) and latency (ms), over graded cases only. */
export interface PrGateAverages {
	readonly averageTokens: number;
	readonly averageDurationMs: number;
}

export interface PrGateReport {
	readonly goldenSetSize: number;
	readonly reportOnly: boolean;
	readonly shouldBlock: boolean;
	/**
	 * Whether ANY case recorded `case-failed` this run — surfaced separately
	 * from `shouldBlock` because `runNightlyEval` deliberately records a
	 * transient provider error or a judge schema rejection as `case-failed`
	 * precisely so that error doesn't abort the run (see `nightly.ts`'s module
	 * doc). Escalating *every* case failure into a merge block would fail PRs on
	 * infra flakiness unrelated to the PR's own change, so a bare failure is
	 * reported for visibility only — see `hasNewCaseFailure` for the subset that
	 * does block.
	 */
	readonly hasCaseFailure: boolean;
	/**
	 * Whether any case failed *this* run that was graded (ran to completion) in
	 * the baseline — a case that used to run and now errors is a
	 * PR-introduced deterministic break (e.g. the PR broke the eval boundary so
	 * every judge call schema-rejects), not the persistent infra flakiness a
	 * bare `hasCaseFailure` conflates it with (that would be `case-failed` in the
	 * baseline too). This is the failure subset the gate blocks on, alongside
	 * `hasRegression`. Requires a baseline: with none we can't tell the two
	 * apart, so it is `false` and only `hasCaseFailure` (report-only) fires.
	 */
	readonly hasNewCaseFailure: boolean;
	readonly passRate: {
		readonly current: number;
		readonly previous?: number;
		readonly delta?: number;
	};
	readonly triggerBalance: {
		readonly overTriggerIds: readonly string[];
		readonly overTriggerCount: number;
		readonly underTriggerIds: readonly string[];
		readonly underTriggerCount: number;
	};
	readonly current: PrGateAverages;
	readonly previous?: PrGateAverages;
}

function gradedResults(results: readonly NightlyCaseResult[]): readonly GradedCaseResult[] {
	return results.filter((result): result is GradedCaseResult => !result.skipped);
}

function computePassRate(results: readonly NightlyCaseResult[]): number {
	if (results.length === 0) {
		return 0;
	}
	const passing = results.filter((result) => !result.skipped && !result.regressed).length;
	return passing / results.length;
}

function computeAverages(sample: PrGateRunSample): PrGateAverages {
	const graded = gradedResults(sample.results);
	if (graded.length === 0) {
		return { averageTokens: 0, averageDurationMs: 0 };
	}
	const totalTokens = graded.reduce((sum, result) => sum + result.totalTokens, 0);
	return {
		averageTokens: totalTokens / graded.length,
		averageDurationMs: sample.totalDurationMs / graded.length,
	};
}

function computeTriggerBalance(
	current: readonly NightlyCaseResult[],
	previous: readonly NightlyCaseResult[] | undefined,
): PrGateReport["triggerBalance"] {
	const overTriggerIds: string[] = [];
	const underTriggerIds: string[] = [];

	if (previous) {
		const previousById = new Map(previous.map((result) => [result.id, result]));
		for (const currentResult of current) {
			if (currentResult.skipped) {
				continue;
			}
			const previousResult = previousById.get(currentResult.id);
			if (!previousResult || previousResult.skipped) {
				continue;
			}
			if (currentResult.regressed && !previousResult.regressed) {
				overTriggerIds.push(currentResult.id);
			} else if (!currentResult.regressed && previousResult.regressed) {
				underTriggerIds.push(currentResult.id);
			}
		}
	}

	return {
		overTriggerIds,
		overTriggerCount: overTriggerIds.length,
		underTriggerIds,
		underTriggerCount: underTriggerIds.length,
	};
}

/** Computes the 3 PR-gate metrics plus the report-only half-gate (Req 5.3/5.4). */
export function computePrGateMetrics(
	current: PrGateRunSample,
	previous?: PrGateRunSample,
): PrGateReport {
	const goldenSetSize = current.results.length;
	const reportOnly = goldenSetSize < PR_GATE_MIN_CASES_FOR_BLOCKING;

	const currentPassRate = computePassRate(current.results);
	const hasRegression = current.results.some((result) => !result.skipped && result.regressed);
	const hasCaseFailure = current.results.some(
		(result) => result.skipped && result.reason === "case-failed",
	);
	const previousById = previous
		? new Map(previous.results.map((result) => [result.id, result]))
		: undefined;
	const hasNewCaseFailure = current.results.some((result) => {
		if (!(result.skipped && result.reason === "case-failed")) {
			return false;
		}
		const previousResult = previousById?.get(result.id);
		// Block only when this case ran (graded, non-skipped) in the baseline but
		// fails now — a PR-introduced deterministic break. A case that was already
		// skipped/failed in the baseline is persistent flakiness we don't escalate.
		return previousResult !== undefined && !previousResult.skipped;
	});

	return {
		goldenSetSize,
		reportOnly,
		shouldBlock: !reportOnly && (hasRegression || hasNewCaseFailure),
		hasCaseFailure,
		hasNewCaseFailure,
		passRate: {
			current: currentPassRate,
			...(previous
				? (() => {
						const previousPassRate = computePassRate(previous.results);
						return { previous: previousPassRate, delta: currentPassRate - previousPassRate };
					})()
				: {}),
		},
		triggerBalance: computeTriggerBalance(current.results, previous?.results),
		current: computeAverages(current),
		...(previous ? { previous: computeAverages(previous) } : {}),
	};
}

function readBaselineSample(path: string | undefined): PrGateRunSample | undefined {
	if (!path) {
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as PrGateRunSample;
	} catch {
		return undefined;
	}
}

export interface RunPrGateOptions {
	/** Path to a previous run's `PrGateRunSample` JSON (Task 10.3 supplies this via CI cache/artifact). */
	readonly baselinePath?: string;
	/** Path to persist the current run's `PrGateRunSample` JSON as the next baseline. */
	readonly outputPath?: string;
}

/** Drives a real `runNightlyEval()` run, times it, and diffs it against an on-disk baseline. */
export async function runPrGate(options: RunPrGateOptions = {}): Promise<PrGateReport> {
	const costCapTokens = resolveCostCapFromEnv(process.env);
	const tier2BaseUrl = resolveTier2BaseUrlFromEnv(process.env);

	const startedAt = performance.now();
	const summary = await runNightlyEval({
		...(costCapTokens === undefined ? {} : { costCapTokens }),
		...(tier2BaseUrl === undefined ? {} : { tier2BaseUrl }),
	});
	const totalDurationMs = performance.now() - startedAt;

	// `computePrGateMetrics` derives `goldenSetSize`/`reportOnly` from
	// `results.length` (needed so it stays a pure function testable with
	// synthetic samples of any size — see pr-gate.spec.ts). That derivation is
	// only safe because `runNightlyEval` always pushes exactly one result per
	// golden case; nothing else pins that contract, so a future change there
	// (an early return, a `.filter`) could silently shrink `results.length`
	// below `PR_GATE_MIN_CASES_FOR_BLOCKING` and disable merge-blocking without
	// anyone noticing. Fail loud here instead — `runPrGate` always drives the
	// default `GOLDEN_SET` (no `goldenSet` override is threaded through).
	if (summary.results.length !== GOLDEN_SET.length) {
		throw new Error(
			`runNightlyEval returned ${summary.results.length} result(s) for a ` +
				`${GOLDEN_SET.length}-case golden set; expected exactly one result per case.`,
		);
	}

	const current: PrGateRunSample = { results: summary.results, totalDurationMs };
	const previous = readBaselineSample(options.baselinePath);

	if (options.outputPath) {
		writeFileSync(options.outputPath, JSON.stringify(current, null, 2));
	}

	return computePrGateMetrics(current, previous);
}

/**
 * CLI entrypoint. Exits non-zero when `shouldBlock` is true (Req 5.4) so
 * `eval-pr.yml` can fail the check; report-only runs always exit 0 regardless
 * of what the metrics show. A case failure that is *new* vs. the baseline blocks
 * (a PR-introduced break — see `PrGateReport.hasNewCaseFailure`); a persistent
 * one only warns so infra flakiness can't fail the PR.
 */
async function main(): Promise<void> {
	initTelemetry();
	const report = await runPrGate({
		baselinePath: process.env.PR_GATE_BASELINE_PATH,
		outputPath: process.env.PR_GATE_OUTPUT_PATH,
	});

	console.log(JSON.stringify(report, null, 2));

	if (report.hasCaseFailure && !report.hasNewCaseFailure) {
		console.warn(
			"[eval:pr-gate] non-blocking: at least one case recorded case-failed this run " +
				"but was not graded in the baseline either (persistent infra/judge flakiness, " +
				"not a PR-introduced regression).",
		);
	}
	if (report.shouldBlock) {
		console.error(
			report.hasNewCaseFailure
				? "[eval:pr-gate] blocking: a case that ran in the baseline now fails (a regression or PR-introduced break was detected)."
				: "[eval:pr-gate] blocking: a regression was detected.",
		);
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error("[eval:pr-gate] run failed:", error);
		process.exitCode = 1;
	});
}
