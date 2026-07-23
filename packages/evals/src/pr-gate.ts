import { readFileSync, writeFileSync } from "node:fs";
import { initTelemetry } from "@vaz/config/telemetry";
import type { GradedCaseResult, NightlyCaseResult } from "./nightly";
import { resolveCostCapFromEnv, runNightlyEval } from "./nightly";
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

	return {
		goldenSetSize,
		reportOnly,
		shouldBlock: !reportOnly && (hasRegression || hasCaseFailure),
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
 * of what the metrics show.
 */
async function main(): Promise<void> {
	initTelemetry();
	const report = await runPrGate({
		baselinePath: process.env.PR_GATE_BASELINE_PATH,
		outputPath: process.env.PR_GATE_OUTPUT_PATH,
	});

	console.log(JSON.stringify(report, null, 2));

	if (report.shouldBlock) {
		console.error("[eval:pr-gate] blocking: a regression or case failure was detected.");
		process.exitCode = 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error: unknown) => {
		console.error("[eval:pr-gate] run failed:", error);
		process.exitCode = 1;
	});
}
