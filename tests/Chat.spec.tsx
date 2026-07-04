import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "@/features/chat/Chat";

const sendMessage = vi.fn();

const useChatState = {
	messages: [] as unknown[],
	sendMessage,
	status: "ready" as string,
	error: undefined as Error | undefined,
};

vi.mock("@ai-sdk/react", () => ({
	useChat: () => useChatState,
}));

beforeEach(() => {
	sendMessage.mockClear();
	useChatState.messages = [];
	useChatState.status = "ready";
	useChatState.error = undefined;
});

describe("Chat", () => {
	test("見出しと入力欄を表示する", () => {
		render(<Chat />);
		expect(screen.getByRole("heading", { name: "vaz-ai-next" })).toBeInTheDocument();
		expect(screen.getByPlaceholderText(/メッセージを入力/)).toBeInTheDocument();
	});

	test("text パートと tool パートをレンダリングする", () => {
		useChatState.messages = [
			{
				id: "m1",
				role: "user",
				parts: [{ type: "text", text: "今何時?" }],
			},
			{
				id: "m2",
				role: "assistant",
				parts: [
					{
						type: "tool-getCurrentTime",
						state: "output-available",
						output: { timeZone: "Asia/Tokyo" },
					},
					{ type: "text", text: "東京は 12 時です" },
				],
			},
		];
		render(<Chat />);
		expect(screen.getByText("今何時?")).toBeInTheDocument();
		expect(screen.getByText("東京は 12 時です")).toBeInTheDocument();
		// Tool calls are surfaced as a tag showing the tool name.
		expect(screen.getByText(/getCurrentTime/)).toBeInTheDocument();
	});

	test("入力を送信すると sendMessage が呼ばれ入力欄がクリアされる", async () => {
		const user = userEvent.setup();
		render(<Chat />);
		const input = screen.getByPlaceholderText<HTMLInputElement>(/メッセージを入力/);
		await user.type(input, "こんにちは");
		await user.click(screen.getByRole("button", { name: "送信" }));
		expect(sendMessage).toHaveBeenCalledWith({ text: "こんにちは" });
		expect(input.value).toBe("");
	});

	test("空入力では送信できない", async () => {
		const user = userEvent.setup();
		render(<Chat />);
		const button = screen.getByRole("button", { name: "送信" });
		expect(button).toBeDisabled();
		await user.click(button);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	test("エラー時に通知を表示する", () => {
		useChatState.error = new Error("boom");
		render(<Chat />);
		expect(screen.getByText("boom")).toBeInTheDocument();
	});
});
