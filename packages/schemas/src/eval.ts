import { z } from "zod";

/**
 * LLM-as-judge grading contract (R4.5, Phase 4).
 *
 * The tier3 judge (`@vaz/evals#judge.ts`) grades a run on two
 * INDEPENDENT axes rather than one blended score:
 *   - `outcome`  — the final artifact (did the answer/document satisfy the brief?).
 *   - `behavior` — the process that produced it (right tools, right order, no
 *     unsafe/needless steps), mirroring the sandbox `eval-graders` pattern.
 *
 * Keeping them separate lets the evaluator-optimizer loop (R4.4/4.5) and the
 * nightly regression check (R4.6) tell "wrong answer" apart from "right answer,
 * bad process" — the latter is a real defect (wasted tool calls, skipped
 * safety checks) that a single combined score would hide.
 */

/**
 * A single axis of a {@link gradeReportSchema}. `score` is normalized to
 * `[0, 1]` (the evalite/promptfoo convention) rather than an arbitrary scale,
 * so scores are comparable across judges and across the outcome/behavior
 * axes. `rationale` is required and non-empty: a judge score without its
 * reasoning is not auditable and cannot be debugged when it regresses.
 */
export const gradeAxisSchema = z.object({
	score: z.number().min(0).max(1),
	rationale: z.string().min(1),
});

export type GradeAxis = z.infer<typeof gradeAxisSchema>;

/**
 * The LLM-as-judge output contract (R4.5): `outcome` and `behavior`, each a
 * {@link gradeAxisSchema}, scored independently of one another.
 */
export const gradeReportSchema = z.object({
	outcome: gradeAxisSchema,
	behavior: gradeAxisSchema,
});

export type GradeReport = z.infer<typeof gradeReportSchema>;
