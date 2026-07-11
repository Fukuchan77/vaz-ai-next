"use client";

import { Button, InlineNotification, Tag, TextInput, Tile } from "@carbon/react";
import type { JobEvent, SpecialistKind } from "@vaz/schemas/workflows";
import { useId, useState } from "react";
import { useJobStream } from "./useJobStream";

/**
 * Client-side mirror of the worker's `requiresApproval(stepId)` predicate
 * (`apps/worker/src/main.ts`), extended with the specialist `kind` carried on
 * the `step-start` event: the approval UI decides "which step is destructive"
 * from the step-start event (`kind`) plus the `requiresApproval` predicate.
 * The worker's own gate is wired but not yet activated for any kind, so the
 * default here is likewise inert (`() => false`) — a caller opts specific kinds
 * in once the server side activates them, rather than this panel guessing.
 */
export type RequiresApprovalPredicate = (step: { stepId: string; kind: SpecialistKind }) => boolean;

export interface ApprovalPanelProps {
	jobId: string;
	requiresApproval?: RequiresApprovalPredicate;
}

type StepStartEvent = JobEvent & { type: "step-start" };
type ErrorEvent = JobEvent & { type: "error" };

/** Approval-denial reasons the worker's `ApprovalDeniedError` may surface as
 * the `error` event's structured `code` (`apps/worker/src/main.ts`'s
 * `ApprovalDeniedReason`) — read the typed field rather than parsing the
 * human-readable `message` string. */
const APPROVAL_DENIAL_REASONS = new Set(["rejected", "expired", "misconfigured"]);

/** A JSON example of the pending step's editable arguments (R3.4), tailored
 * to its specialist `kind` so the operator edits a shape that actually
 * matches what will run. */
function argsPlaceholderFor(kind: SpecialistKind): string {
	switch (kind) {
		case "rag-research":
			return '{"query":"...","topK":5}';
		case "document-generation":
			return '{"instructions":"...","format":"markdown"}';
		case "data-processing":
			return '{"operation":"...","input":{}}';
		default:
			return "{}";
	}
}

/**
 * The most recent `step-start` event that (a) satisfies `requiresApproval` and
 * (b) has no later `completion`/`error` for the same `stepId` yet. The
 * supervisor dispatches steps strictly one at a time (`packages/agents/src/
 * supervisor.ts`), so at most one step is ever actually unresolved — this
 * scans defensively rather than assuming that invariant.
 */
function findPendingStep(
	events: JobEvent[],
	requiresApproval: RequiresApprovalPredicate,
): StepStartEvent | null {
	const resolvedStepIds = new Set(
		events
			.filter((event) => event.type === "completion" || event.type === "error")
			.map((event) => (event as { stepId?: string }).stepId)
			.filter((id): id is string => id !== undefined),
	);

	let pending: StepStartEvent | null = null;
	for (const event of events) {
		if (event.type !== "step-start") continue;
		if (resolvedStepIds.has(event.stepId)) continue;
		if (!requiresApproval({ stepId: event.stepId, kind: event.kind })) continue;
		pending = event;
	}
	return pending;
}

function findLatestError(events: JobEvent[]): ErrorEvent | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "error") return event;
	}
	return null;
}

/** Reads an approval-denial reason off the error event's structured `code` + `stepId`. */
function parseDenial(error: ErrorEvent): { stepId: string; reason: string } | null {
	if (!error.stepId || !error.code || !APPROVAL_DENIAL_REASONS.has(error.code)) return null;
	return { stepId: error.stepId, reason: error.code };
}

/**
 * `ApprovalPanel` — the HITL approve / reject / edit-args UI (R3.4). Consumes
 * `useJobStream` and, for the step currently awaiting a decision, POSTs to
 * `/api/jobs/:id/approve`: the step's `stepId` is sent as `toolCallId` (the
 * HTTP↔engine naming bridge `POST /api/jobs/:id/approve` establishes) with
 * `decision` and an optional edited `args` JSON payload.
 *
 * `args` starts empty rather than pre-filled from a `tool-call` event: a
 * gated step suspends in `createDurableStepRunner` *before* its specialist
 * function runs, so no `tool-call` event (which only fires from inside that
 * function) exists yet to read defaults from — editing here is a plain
 * override the operator supplies, not a pre-filled correction.
 */
/**
 * The decision form for one pending step. Keyed by `step.stepId` from the
 * parent so a *new* pending step remounts this component fresh — the
 * idiomatic React reset-on-identity-change, in place of a `useEffect` that
 * would otherwise reset local state without ever reading `step` in its body.
 */
function ApprovalDecisionForm({ jobId, step }: { jobId: string; step: StepStartEvent }) {
	const argsInputId = useId();
	const [argsText, setArgsText] = useState("");
	const [argsError, setArgsError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [decided, setDecided] = useState(false);

	async function submitDecision(decision: "approve" | "reject") {
		let args: unknown;
		if (decision === "approve" && argsText.trim() !== "") {
			try {
				args = JSON.parse(argsText);
			} catch {
				setArgsError("引数は有効な JSON で入力してください");
				return;
			}
		}
		setArgsError(null);
		setSubmitting(true);
		setSubmitError(null);
		try {
			const response = await fetch(`/api/jobs/${jobId}/approve`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					toolCallId: step.stepId,
					decision,
					...(args !== undefined ? { args } : {}),
				}),
			});
			if (!response.ok) {
				throw new Error(`Approval request failed with status ${response.status}`);
			}
			setDecided(true);
		} catch (caught) {
			setSubmitError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div>
			<p>
				<Tag type="purple" size="sm">
					{step.kind}
				</Tag>{" "}
				ステップ ({step.stepId}) が承認待ちです。
			</p>
			<TextInput
				id={argsInputId}
				labelText="引数を編集(JSON, 任意)"
				placeholder={argsPlaceholderFor(step.kind)}
				value={argsText}
				onChange={(event) => setArgsText(event.target.value)}
				disabled={submitting || decided}
				invalid={argsError !== null}
				invalidText={argsError ?? undefined}
			/>
			<Button
				kind="primary"
				type="button"
				disabled={submitting || decided}
				onClick={() => submitDecision("approve")}
			>
				承認
			</Button>
			<Button
				kind="danger"
				type="button"
				disabled={submitting || decided}
				onClick={() => submitDecision("reject")}
			>
				拒否
			</Button>
			{decided && !submitError && <p>決定を送信しました。結果を待っています…</p>}
			{submitError && (
				<InlineNotification kind="error" title="送信エラー" subtitle={submitError} lowContrast />
			)}
		</div>
	);
}

export function ApprovalPanel({ jobId, requiresApproval = () => false }: ApprovalPanelProps) {
	const { events, status, error: streamError } = useJobStream(jobId);

	const pendingStep = findPendingStep(events, requiresApproval);
	const latestError = findLatestError(events);
	const denial = latestError ? parseDenial(latestError) : null;

	return (
		<Tile>
			<h2>承認</h2>
			{pendingStep ? (
				<ApprovalDecisionForm key={pendingStep.stepId} jobId={jobId} step={pendingStep} />
			) : denial ? (
				<InlineNotification
					kind="error"
					title="承認が完了しませんでした"
					subtitle={`ステップ ${denial.stepId}: ${denial.reason}`}
					lowContrast
				/>
			) : latestError ? (
				<InlineNotification
					kind="error"
					title="エラー"
					subtitle={latestError.message}
					lowContrast
				/>
			) : status === "error" && streamError ? (
				<InlineNotification
					kind="error"
					title="接続エラー"
					subtitle={streamError.message}
					lowContrast
				/>
			) : (
				<p>承認待ちのステップはありません。</p>
			)}
		</Tile>
	);
}
