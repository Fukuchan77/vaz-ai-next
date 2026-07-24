import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradedCaseResult, NightlyCaseResult, SkippedCaseResult } from "@vaz/evals/nightly";
import {
	computePrGateMetrics,
	PR_GATE_MIN_CASES_FOR_BLOCKING,
	type PrGateRunSample,
	readBaselineSample,
} from "@vaz/evals/pr-gate";

/**
 * PR-gate 3-metric computation (Req 5.3/5.4): `computePrGateMetrics` is a pure
 * function over already-produced `runNightlyEval` results (`NightlyCaseResult[]`,
 * `@vaz/evals/nightly`) — it never drives the chat agent or the judge itself,
 * it only aggregates/diffs what `runNightlyEval` already computed per case
 * (plan.md Task 10.2: "既存 per-case baseline を PR 用に流用"). `totalDurationMs`
 * is the one piece `runNightlyEval` does not track; the PR-gate CLI entrypoint
 * (Task 10.2's `main()`) wraps the whole `runNightlyEval()` call in wall-clock
 * timing and passes it in here — so "per-case average latency" is a run-level
 * aggregate divided by graded-case count, exactly like "per-case average cost"
 * (`totalTokens` summed then divided), not a true per-case timestamp.
 *
 * Metric semantics locked by this spec (Req 5.3):
 *  - **pass-rate delta vs. previous**: `passRate.current` is
 *    `(graded && !regressed) / results.length` — the full golden-set size is
 *    the denominator, so a skipped case (either `cost-cap-exceeded` or
 *    `case-failed`) counts against the rate exactly like a regression does; a
 *    skip validated nothing, so it cannot read as a pass. `passRate.previous`/
 *    `.delta` are only present when a baseline sample is given.
 *  - **over/under-trigger balance**: reuses the *same* per-case `regressed`
 *    baseline flag `runNightlyEval` already derives from each `GoldenCase`'s
 *    `minOutcomeScore`/`minBehaviorScore` (see `nightly.ts`), just diffed
 *    across two runs instead of against a single static threshold once.
 *    "Over-trigger" = a case regressed now that did not regress in the
 *    baseline (a new alarm). "Under-trigger" = the reverse (a baseline alarm
 *    that has gone quiet). Only cases graded (non-skipped) on *both* sides are
 *    compared — a skip on either side means "regressed" is not a meaningful
 *    signal for that case, so it is excluded from the balance rather than
 *    guessed at; likewise a case id present on only one side (golden set
 *    changed between runs) is excluded.
 *  - **per-case average cost/latency**: averaged over graded (non-skipped)
 *    cases only, both for `current` and (when given) `previous` — a skipped
 *    case's `totalTokens` is 0 by construction (it never ran), and including
 *    it in the denominator would understate the real per-run cost/latency.
 *
 * Report-only half-gate (Req 5.4): `reportOnly` is `true` whenever
 * `results.length < PR_GATE_MIN_CASES_FOR_BLOCKING` (20, matching the golden
 * set's Req 5.1 floor) — in that mode `shouldBlock` is always `false`
 * regardless of regressions/failures, mirroring the spec's explicit
 * "threshold-based merge blocking SHALL be enabled only after 5.1 is met".
 * Once at/above the floor, `shouldBlock` is `true` iff the current run has
 * either a regressed case (a graded case scoring below its own baseline) or a
 * *new* case failure (`hasNewCaseFailure`: a case graded in the baseline that
 * now records `case-failed` — a PR-introduced deterministic break, e.g. the PR
 * broke the eval boundary so every judge call schema-rejects). A
 * `cost-cap-exceeded` skip never blocks (a budget artifact), and a `case-failed`
 * skip that was *also* skipped/failed in the baseline never blocks either —
 * that's persistent infra/judge flakiness `runNightlyEval` deliberately swallows
 * so the run doesn't abort (see `nightly.ts`'s module doc), not a regression the
 * PR introduced. Every `case-failed` skip is still surfaced via
 * `PrGateReport.hasCaseFailure` for visibility whether or not it blocks. With no
 * baseline the new-vs-persistent distinction can't be made, so `hasNewCaseFailure`
 * is `false` and a bare case failure stays report-only.
 */

function gradedCase(
	id: string,
	overrides: Partial<Pick<GradedCaseResult, "regressed" | "totalTokens">> = {},
): GradedCaseResult {
	const regressed = overrides.regressed ?? false;
	return {
		id,
		request: `request-${id}`,
		grade: {
			outcome: { score: regressed ? 0.1 : 0.9, rationale: "r" },
			behavior: { score: regressed ? 0.1 : 0.9, rationale: "r" },
		},
		totalTokens: overrides.totalTokens ?? 100,
		regressed,
		skipped: false,
	};
}

function skippedCase(
	id: string,
	reason: SkippedCaseResult["reason"] = "case-failed",
): SkippedCaseResult {
	return { id, request: `request-${id}`, skipped: true, reason };
}

function sample(results: readonly NightlyCaseResult[], totalDurationMs = 1000): PrGateRunSample {
	return { results, totalDurationMs };
}

/**
 * Builds a golden-set-sized run (`count` graded, all passing) so blocking
 * tests can cross the Req 5.1 floor without hand-writing 20 fixtures per test.
 */
function passingRunOfSize(count: number, totalDurationMs = 1000): PrGateRunSample {
	return sample(
		Array.from({ length: count }, (_, i) => gradedCase(`case-${i}`)),
		totalDurationMs,
	);
}

describe("computePrGateMetrics — pass rate (Req 5.3)", () => {
	test("computes the current pass rate as (graded && !regressed) / full golden-set size", () => {
		const current = sample([
			gradedCase("a"),
			gradedCase("b"),
			gradedCase("c", { regressed: true }),
			skippedCase("d", "case-failed"),
		]);

		const report = computePrGateMetrics(current);

		expect(report.passRate.current).toBeCloseTo(0.5, 5);
	});

	test("reports previous pass rate and delta when a baseline sample is given", () => {
		const current = sample([gradedCase("a"), gradedCase("b"), gradedCase("c"), gradedCase("d")]);
		const previous = sample([
			gradedCase("a"),
			gradedCase("b", { regressed: true }),
			gradedCase("c", { regressed: true }),
			gradedCase("d", { regressed: true }),
		]);

		const report = computePrGateMetrics(current, previous);

		expect(report.passRate.current).toBeCloseTo(1, 5);
		expect(report.passRate.previous).toBeCloseTo(0.25, 5);
		expect(report.passRate.delta).toBeCloseTo(0.75, 5);
	});

	test("leaves previous and delta undefined without a baseline sample", () => {
		const report = computePrGateMetrics(sample([gradedCase("a")]));

		expect(report.passRate.previous).toBeUndefined();
		expect(report.passRate.delta).toBeUndefined();
	});

	test("treats an empty golden set as a 0 pass rate, not NaN", () => {
		const report = computePrGateMetrics(sample([]));

		expect(report.passRate.current).toBe(0);
	});
});

describe("computePrGateMetrics — over/under-trigger balance (Req 5.3)", () => {
	test("flags a case regressed now but not in the baseline as an over-trigger", () => {
		const current = sample([gradedCase("a", { regressed: true })]);
		const previous = sample([gradedCase("a", { regressed: false })]);

		const report = computePrGateMetrics(current, previous);

		expect(report.triggerBalance.overTriggerIds).toEqual(["a"]);
		expect(report.triggerBalance.overTriggerCount).toBe(1);
		expect(report.triggerBalance.underTriggerIds).toEqual([]);
	});

	test("flags a case regressed in the baseline but not now as an under-trigger", () => {
		const current = sample([gradedCase("a", { regressed: false })]);
		const previous = sample([gradedCase("a", { regressed: true })]);

		const report = computePrGateMetrics(current, previous);

		expect(report.triggerBalance.underTriggerIds).toEqual(["a"]);
		expect(report.triggerBalance.underTriggerCount).toBe(1);
		expect(report.triggerBalance.overTriggerIds).toEqual([]);
	});

	test("excludes a case skipped on either side from the balance even when both sides share the id", () => {
		const current = sample([skippedCase("a", "case-failed")]);
		const previous = sample([gradedCase("a", { regressed: true })]);

		const report = computePrGateMetrics(current, previous);

		expect(report.triggerBalance.overTriggerIds).toEqual([]);
		expect(report.triggerBalance.underTriggerIds).toEqual([]);
	});

	test("excludes a case id present on only one side (golden set changed between runs)", () => {
		const current = sample([gradedCase("a", { regressed: true }), gradedCase("new-case")]);
		const previous = sample([gradedCase("a", { regressed: false })]);

		const report = computePrGateMetrics(current, previous);

		expect(report.triggerBalance.overTriggerIds).toEqual(["a"]);
	});

	test("reports an empty balance when there is no baseline to diff against", () => {
		const report = computePrGateMetrics(sample([gradedCase("a", { regressed: true })]));

		expect(report.triggerBalance.overTriggerIds).toEqual([]);
		expect(report.triggerBalance.underTriggerIds).toEqual([]);
		expect(report.triggerBalance.overTriggerCount).toBe(0);
		expect(report.triggerBalance.underTriggerCount).toBe(0);
	});
});

describe("computePrGateMetrics — per-case average cost/latency (Req 5.3)", () => {
	test("averages current totalTokens and totalDurationMs over graded cases only", () => {
		const current = sample(
			[
				gradedCase("a", { totalTokens: 100 }),
				gradedCase("b", { totalTokens: 300 }),
				skippedCase("c"),
			],
			600,
		);

		const report = computePrGateMetrics(current);

		expect(report.current.averageTokens).toBeCloseTo(200, 5);
		expect(report.current.averageDurationMs).toBeCloseTo(300, 5);
	});

	test("reports previous averages when a baseline sample is given, undefined otherwise", () => {
		const current = sample([gradedCase("a", { totalTokens: 100 })], 100);
		const previous = sample(
			[gradedCase("a", { totalTokens: 200 }), gradedCase("b", { totalTokens: 400 })],
			900,
		);

		const withBaseline = computePrGateMetrics(current, previous);
		expect(withBaseline.previous?.averageTokens).toBeCloseTo(300, 5);
		expect(withBaseline.previous?.averageDurationMs).toBeCloseTo(450, 5);

		const withoutBaseline = computePrGateMetrics(current);
		expect(withoutBaseline.previous).toBeUndefined();
	});

	test("reports 0 averages (not NaN) when every case was skipped", () => {
		const report = computePrGateMetrics(sample([skippedCase("a"), skippedCase("b")], 500));

		expect(report.current.averageTokens).toBe(0);
		expect(report.current.averageDurationMs).toBe(0);
	});
});

describe("computePrGateMetrics — report-only half-gate (Req 5.4)", () => {
	test(`is report-only (non-blocking) below ${PR_GATE_MIN_CASES_FOR_BLOCKING} cases regardless of regressions`, () => {
		const belowFloor = sample([
			gradedCase("a", { regressed: true }),
			skippedCase("b", "case-failed"),
		]);

		const report = computePrGateMetrics(belowFloor);

		expect(report.goldenSetSize).toBe(2);
		expect(report.reportOnly).toBe(true);
		expect(report.shouldBlock).toBe(false);
	});

	test(`is not report-only once the golden set reaches ${PR_GATE_MIN_CASES_FOR_BLOCKING} cases`, () => {
		const atFloor = passingRunOfSize(PR_GATE_MIN_CASES_FOR_BLOCKING);

		const report = computePrGateMetrics(atFloor);

		expect(report.goldenSetSize).toBe(PR_GATE_MIN_CASES_FOR_BLOCKING);
		expect(report.reportOnly).toBe(false);
	});

	test("blocks at/above the floor when any case has regressed", () => {
		const results = Array.from({ length: PR_GATE_MIN_CASES_FOR_BLOCKING }, (_, i) =>
			gradedCase(`case-${i}`, { regressed: i === 0 }),
		);

		const report = computePrGateMetrics(sample(results));

		expect(report.reportOnly).toBe(false);
		expect(report.shouldBlock).toBe(true);
	});

	test("does not block at/above the floor for a case-failed skip with no baseline (can't tell new from persistent), but flags hasCaseFailure", () => {
		const results: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		results.push(skippedCase("case-failed-one", "case-failed"));

		const report = computePrGateMetrics(sample(results));

		expect(report.reportOnly).toBe(false);
		expect(report.shouldBlock).toBe(false);
		expect(report.hasCaseFailure).toBe(true);
		expect(report.hasNewCaseFailure).toBe(false);
	});

	test("blocks at/above the floor when a case graded in the baseline now records case-failed (PR-introduced break)", () => {
		const currentResults: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		currentResults.push(skippedCase("broke-in-pr", "case-failed"));
		const previousResults: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		// Same id ran (graded) in the baseline — its failure now is a regression.
		previousResults.push(gradedCase("broke-in-pr"));

		const report = computePrGateMetrics(sample(currentResults), sample(previousResults));

		expect(report.reportOnly).toBe(false);
		expect(report.hasNewCaseFailure).toBe(true);
		expect(report.shouldBlock).toBe(true);
	});

	test("does not block at/above the floor when a case-failed case was already skipped in the baseline (persistent flakiness)", () => {
		const currentResults: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		currentResults.push(skippedCase("flaky", "case-failed"));
		const previousResults: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		// Already failing in the baseline — not introduced by this PR.
		previousResults.push(skippedCase("flaky", "case-failed"));

		const report = computePrGateMetrics(sample(currentResults), sample(previousResults));

		expect(report.reportOnly).toBe(false);
		expect(report.hasCaseFailure).toBe(true);
		expect(report.hasNewCaseFailure).toBe(false);
		expect(report.shouldBlock).toBe(false);
	});

	test("flags hasCaseFailure false when every case ran (graded or cost-capped only)", () => {
		const results: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		results.push(skippedCase("cost-capped", "cost-cap-exceeded"));

		const report = computePrGateMetrics(sample(results));

		expect(report.hasCaseFailure).toBe(false);
	});

	test("still blocks at/above the floor on a regression even when a case also failed", () => {
		const results: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 2 },
			(_, i) => gradedCase(`case-${i}`),
		);
		results.push(gradedCase("regressed-one", { regressed: true }));
		results.push(skippedCase("case-failed-one", "case-failed"));

		const report = computePrGateMetrics(sample(results));

		expect(report.reportOnly).toBe(false);
		expect(report.shouldBlock).toBe(true);
		expect(report.hasCaseFailure).toBe(true);
	});

	test("does not block at/above the floor for a cost-cap-exceeded skip alone (a budget artifact, not a regression)", () => {
		const results: NightlyCaseResult[] = Array.from(
			{ length: PR_GATE_MIN_CASES_FOR_BLOCKING - 1 },
			(_, i) => gradedCase(`case-${i}`),
		);
		results.push(skippedCase("cost-capped", "cost-cap-exceeded"));

		const report = computePrGateMetrics(sample(results));

		expect(report.reportOnly).toBe(false);
		expect(report.shouldBlock).toBe(false);
	});

	test("does not block at/above the floor when every case passed cleanly", () => {
		const report = computePrGateMetrics(passingRunOfSize(PR_GATE_MIN_CASES_FOR_BLOCKING));

		expect(report.shouldBlock).toBe(false);
	});
});

/**
 * `readBaselineSample` (Req 5.3): distinguishes "no baseline yet" (missing
 * file — silent, expected on the first PR-gate run or after a cache eviction)
 * from "baseline exists but is unreadable/corrupt" (a real problem that must
 * not silently disable regression blocking without a trace).
 */
describe("readBaselineSample", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pr-gate-baseline-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	test("returns undefined with no warning when no path is given", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(readBaselineSample(undefined)).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	test("returns undefined with no warning when the file does not exist (ENOENT)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(readBaselineSample(join(dir, "missing.json"))).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	test("parses and returns a valid baseline file", () => {
		const path = join(dir, "baseline.json");
		const validSample: PrGateRunSample = { results: [], totalDurationMs: 42 };
		writeFileSync(path, JSON.stringify(validSample));

		expect(readBaselineSample(path)).toEqual(validSample);
	});

	test("warns and returns undefined when the baseline file is not valid JSON (corrupt)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const path = join(dir, "corrupt.json");
		writeFileSync(path, "{ not valid json");

		expect(readBaselineSample(path)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain(path);
	});

	test.each([
		["an empty object", "{}"],
		["an empty array", "[]"],
		["null", "null"],
		["results as a non-array", JSON.stringify({ results: "x", totalDurationMs: 1 })],
		["totalDurationMs as a non-number", JSON.stringify({ results: [], totalDurationMs: "1" })],
	])("warns and returns undefined when the baseline is valid JSON but not a PrGateRunSample (%s)", (_label, json) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const path = join(dir, "wrong-shape.json");
		writeFileSync(path, json);

		expect(readBaselineSample(path)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toContain(path);
	});
});
