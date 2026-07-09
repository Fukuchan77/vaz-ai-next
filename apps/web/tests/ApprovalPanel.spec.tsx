import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JobEvent } from "@vaz/schemas/workflows";
import { ApprovalPanel } from "@/features/jobs/ApprovalPanel";

/**
 * Unit coverage for `ApprovalPanel` (Task 14.5, R3.4): the HITL approve /
 * reject / edit-args UI. `useJobStream` (Task 14.4) is mocked so this
 * exercises only the panel's own event→UI derivation and its POST to
 * `/api/jobs/:id/approve` (Task 14.3) — no real SSE stream, no real Route
 * Handler, no network.
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
	test("承認待ちのステップがない場合は待機メッセージを表示する", () => {
		render(<ApprovalPanel jobId={jobId} />);
		expect(screen.queryByText(/承認待ちのステップはありません/)).not.toBeNull();
	});

	test("requiresApproval が true を返す step-start に承認フォームを表示する", () => {
		useJobStreamState.events = [stepStart];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);
		expect(screen.queryByText(/rag-research/)).not.toBeNull();
		expect(screen.queryByText(new RegExp(stepId))).not.toBeNull();
		expect(screen.getByRole("button", { name: "承認" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "拒否" })).toBeTruthy();
	});

	test("requiresApproval が false を返すステップにはフォームを表示しない(既定値)", () => {
		useJobStreamState.events = [stepStart];
		render(<ApprovalPanel jobId={jobId} />);
		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
		expect(screen.queryByText(/承認待ちのステップはありません/)).not.toBeNull();
	});

	test("completion 済みのステップはフォームを表示しない", () => {
		useJobStreamState.events = [stepStart, completionFor(stepId)];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);
		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
	});

	test("承認ボタンで編集した引数付きの approve が送信される", async () => {
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

	test("拒否ボタンでは args キーを含めずに reject が送信される", async () => {
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

	test("不正な JSON を承認しようとすると送信されずエラーを表示する", async () => {
		useJobStreamState.events = [stepStart];
		const user = userEvent.setup();
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		await user.type(screen.getByLabelText(/引数/), "{{ not json");
		await user.click(screen.getByRole("button", { name: "承認" }));

		expect(fetchMock).not.toHaveBeenCalled();
		expect(screen.queryByText(/有効な JSON/)).not.toBeNull();
	});

	test("送信 API が失敗した場合はエラーを表示する", async () => {
		useJobStreamState.events = [stepStart];
		fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
		const user = userEvent.setup();
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		await user.click(screen.getByRole("button", { name: "承認" }));

		expect(await screen.findByText(/送信エラー/)).not.toBeNull();
	});

	test("Approval rejected エラーを検出すると拒否理由を表示する", () => {
		useJobStreamState.events = [stepStart, approvalErrorFor(stepId, "rejected")];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
		expect(screen.queryByText(/rejected/)).not.toBeNull();
	});

	test("承認と無関係なエラーは汎用エラー表示にフォールバックする", () => {
		useJobStreamState.events = [
			stepStart,
			{ jobId, ts: "2026-01-01T00:00:05.000Z", type: "error", stepId, message: "boom" },
		];
		render(<ApprovalPanel jobId={jobId} requiresApproval={() => true} />);

		expect(screen.queryByText("boom")).not.toBeNull();
	});
});
