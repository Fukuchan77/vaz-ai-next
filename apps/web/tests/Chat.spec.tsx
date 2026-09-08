import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import { Chat } from "@/features/chat/Chat";

/**
 * Unit coverage for `Chat`'s HITL approval UI (X-9): `sendEmail` is the only
 * `needsApproval: true` tool (`@vaz/tools`), so a real chat turn that calls it
 * renders a `tool-sendEmail` part in `state: "approval-requested"`. Before
 * this wiring, nothing in the UI could ever answer that request — the run
 * would suspend forever. `@ai-sdk/react`'s `useChat` is mocked so this
 * exercises only `Chat`'s own part→UI derivation and its calls into
 * `addToolApprovalResponse` — no real model, no real stream, no network.
 */

const addToolApprovalResponse = vi.fn();
const useChatState: { messages: UIMessage[]; status: string; error: Error | null } = {
	messages: [],
	status: "ready",
	error: null,
};

vi.mock("@ai-sdk/react", () => ({
	useChat: () => ({
		messages: useChatState.messages,
		sendMessage: vi.fn(),
		status: useChatState.status,
		error: useChatState.error,
		addToolApprovalResponse,
	}),
}));

function approvalRequestedMessage(
	overrides: { isAutomatic?: boolean; requestReason?: string } = {},
) {
	return {
		id: "assistant-1",
		role: "assistant",
		parts: [
			{
				type: "tool-sendEmail",
				toolCallId: "call-1",
				state: "approval-requested",
				input: { to: "user@example.com", subject: "Hi", body: "Hello" },
				approval: {
					id: "approval-1",
					isAutomatic: overrides.isAutomatic ?? false,
					requestReason: overrides.requestReason,
				},
			},
		],
	} as unknown as UIMessage;
}

beforeEach(() => {
	useChatState.messages = [];
	useChatState.status = "ready";
	useChatState.error = null;
	addToolApprovalResponse.mockReset();
});

describe("Chat — HITL tool approval (X-9)", () => {
	test("renders approve/deny buttons for a manual approval request", () => {
		useChatState.messages = [approvalRequestedMessage()];
		render(<Chat />);

		expect(screen.queryByText(/sendEmail/)).not.toBeNull();
		expect(screen.getByRole("button", { name: "承認" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "却下" })).toBeTruthy();
	});

	test("approve calls addToolApprovalResponse with approved: true", async () => {
		useChatState.messages = [approvalRequestedMessage()];
		const user = userEvent.setup();
		render(<Chat />);

		await user.click(screen.getByRole("button", { name: "承認" }));

		expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: "approval-1", approved: true });
	});

	test("deny calls addToolApprovalResponse with approved: false", async () => {
		useChatState.messages = [approvalRequestedMessage()];
		const user = userEvent.setup();
		render(<Chat />);

		await user.click(screen.getByRole("button", { name: "却下" }));

		expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: "approval-1", approved: false });
	});

	test("renders no approve/deny buttons for an automatic approval decision", () => {
		useChatState.messages = [approvalRequestedMessage({ isAutomatic: true })];
		render(<Chat />);

		expect(screen.queryByRole("button", { name: "承認" })).toBeNull();
		expect(screen.queryByRole("button", { name: "却下" })).toBeNull();
	});

	test("shows the request reason when the policy supplies one", () => {
		useChatState.messages = [
			approvalRequestedMessage({ requestReason: "外部宛の送信は承認が必要です" }),
		];
		render(<Chat />);

		expect(screen.queryByText("外部宛の送信は承認が必要です")).not.toBeNull();
	});
});
