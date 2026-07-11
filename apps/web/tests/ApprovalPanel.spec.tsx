import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JobEvent } from "@vaz/schemas/workflows";
import { ApprovalPanel } from "@/features/jobs/ApprovalPanel";

/**
 * Unit coverage for `ApprovalPanel` (R3.4): the HITL approve / reject /
 * edit-args UI. `useJobStream` is mocked so this exercises only the panel's
 * own event→UI derivation and its POST to `/api/jobs/:id/approve` — no real
 * SSE stream, no real Route Handler, no network.
 */

const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const stepId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";

const useJobStreamState: { events: JobEvent[]; status: string; error: Error | null } = {
	events: [],
	status: "open",
	error: null,
};

vi.mock("@/features/jobs/useJobStream", () => ({
	useJobStream: () => ({
		events: useJobStreamState.events,
		latestEvent: useJobStreamState.events.at(-1) ?? null,
		status: useJobStreamState.status,
		error: useJobStreamState.error,
	}),
}));

const stepStart: JobEvent = {
	jobId,
	ts: "2026-01-01T00:00:00.000Z",
	type: "step-start",
	stepId,
	kind: "rag-research",
};

function completionFor(id: string): JobEvent {
	return { jobId, ts: "2026-01-01T00:00:05.000Z", type: "completion", stepId: id };
}

function approvalErrorFor(id: string, reason: string): JobEvent {
	return {
		jobId,
		ts: "2026-01-01T00:00:05.000Z",
		type: "error",
		stepId: id,
		message: `Approval ${reason} for step "${id}".`,
		code: reason,
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	useJobStreamState.events = [];
	useJobStreamState.status = "open";
	useJobStreamState.error = null;
	fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ApprovalPanel", () => {
	test("shows the idle message when no step is awaiting approval", () => {
		render(<ApprovalPanel jobId={jobId} />);
		expect(screen.queryByText(/承認待ちのステップはありません/)).not.toBeNull();
	});

	test("renders the approval form for a step-start where requiresApproval returns true", () => {
		useJobStreamState.events = [stepStart];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);
		expect(screen.queryByText(/rag-research/)).not.toBeNull();
		expect(screen.queryByText(new RegExp(stepId))).not.toBeNull();
		expect(screen.getByRole("button", { name: "承認" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "拒否" })).toBeTruthy();
	});

	test("renders no form for a step where requiresApproval returns false (default)", () => {
		useJobStreamState.events = [stepStart];
		render(<ApprovalPanel jobId={jobId} />);
		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
		expect(screen.queryByText(/承認待ちのステップはありません/)).not.toBeNull();
	});

	test("renders no form for an already-completed step", () => {
		useJobStreamState.events = [stepStart, completionFor(stepId)];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);
		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
	});

	test("submits approve with edited args from the approve button", async () => {
		useJobStreamState.events = [stepStart];
		const user = userEvent.setup();
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		await user.type(screen.getByLabelText(/引数/), '{{"to":"user@example.com"}');
		await user.click(screen.getByRole("button", { name: "承認" }));

		expect(fetchMock).toHaveBeenCalledWith(
			`/api/jobs/${jobId}/approve`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					toolCallId: stepId,
					decision: "approve",
					args: { to: "user@example.com" },
				}),
			}),
		);
	});

	test("submits reject without an args key from the reject button", async () => {
		useJobStreamState.events = [stepStart];
		const user = userEvent.setup();
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		await user.type(screen.getByLabelText(/引数/), "this text is ignored on reject");
		await user.click(screen.getByRole("button", { name: "拒否" }));

		expect(fetchMock).toHaveBeenCalledWith(
			`/api/jobs/${jobId}/approve`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ toolCallId: stepId, decision: "reject" }),
			}),
		);
	});

	test("shows an error and does not submit when approving invalid JSON", async () => {
		useJobStreamState.events = [stepStart];
		const user = userEvent.setup();
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		await user.type(screen.getByLabelText(/引数/), "{{ not json");
		await user.click(screen.getByRole("button", { name: "承認" }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.queryByText(/有効な JSON/)).not.toBeNull();
	});

	test("shows an error when the submit API fails", async () => {
		useJobStreamState.events = [stepStart];
		fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
		const user = userEvent.setup();
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		await user.click(screen.getByRole("button", { name: "承認" }));

		expect(await screen.findByText(/送信エラー/)).not.toBeNull();
	});

	test("shows the denial reason when an approval-rejected error is detected", () => {
		useJobStreamState.events = [stepStart, approvalErrorFor(stepId, "rejected")];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
		expect(screen.queryByText(/rejected/)).not.toBeNull();
	});

	test("falls back to a generic error display for errors unrelated to approval", () => {
		useJobStreamState.events = [
			stepStart,
			{ jobId, ts: "2026-01-01T00:00:05.000Z", type: "error", stepId, message: "boom" },
		];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		expect(screen.queryByText("boom")).not.toBeNull();
	});
});
