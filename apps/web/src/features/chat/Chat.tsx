"use client";

import { useChat } from "@ai-sdk/react";
import {
	Button,
	Column,
	Content,
	Form,
	Grid,
	InlineLoading,
	InlineNotification,
	Tag,
	TextInput,
	Theme,
	Tile,
} from "@carbon/react";
import type {
	ChatAddToolApproveResponseFunction,
	DynamicToolUIPart,
	ToolUIPart,
	UIDataTypes,
	UIMessagePart,
	UITools,
} from "ai";
import { getToolName, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useState } from "react";
import styles from "./Chat.module.scss";

/**
 * Renders a `needsApproval` tool call's approval-request state (HITL, R3.4)
 * with Approve/Deny buttons wired to `useChat()`'s `addToolApprovalResponse`
 * (X-9) — without this, `sendEmail` would suspend forever on every call,
 * since nothing in the UI could ever answer the pending approval.
 * `part.approval.isAutomatic` guards out the (currently unused) automatic-
 * approval/denial states per the AI SDK's own `useChat` example: only a
 * manual `'user-approval'` decision needs buttons.
 */
function ToolApprovalRequest({
	part,
	toolName,
	onRespond,
}: {
	part: Extract<ToolUIPart | DynamicToolUIPart, { state: "approval-requested" }>;
	toolName: string;
	onRespond: ChatAddToolApproveResponseFunction;
}) {
	if (part.approval.isAutomatic) {
		return null;
	}
	return (
		<span className={styles.tool}>
			<Tag type="magenta" size="sm">
				🔒 {toolName}: 承認待ち
			</Tag>
			{part.approval.requestReason && (
				<p className={styles.approvalReason}>{part.approval.requestReason}</p>
			)}
			<Button
				size="sm"
				kind="primary"
				onClick={() => onRespond({ id: part.approval.id, approved: true })}
			>
				承認
			</Button>
			<Button
				size="sm"
				kind="danger--tertiary"
				onClick={() => onRespond({ id: part.approval.id, approved: false })}
			>
				却下
			</Button>
		</span>
	);
}

function MessagePart({
	part,
	onRespondToApproval,
}: {
	part: UIMessagePart<UIDataTypes, UITools>;
	onRespondToApproval: ChatAddToolApproveResponseFunction;
}) {
	if (part.type === "text") {
		return <span className={styles.text}>{part.text}</span>;
	}
	// Tool calls (static `tool-{name}` and MCP-style dynamic tools alike) are
	// surfaced as a tag showing execution state.
	if (isToolUIPart(part)) {
		const toolName = getToolName(part);
		if (part.state === "approval-requested") {
			return (
				<ToolApprovalRequest part={part} toolName={toolName} onRespond={onRespondToApproval} />
			);
		}
		const output = "output" in part && part.output != null ? JSON.stringify(part.output) : null;
		return (
			<span className={styles.tool}>
				<Tag type="teal" size="sm">
					🔧 {toolName}
				</Tag>
				{output && <code className={styles.toolOutput}>{output}</code>}
			</span>
		);
	}
	return null;
}

export function Chat() {
	const [input, setInput] = useState("");
	const { messages, sendMessage, status, error, addToolApprovalResponse } = useChat({
		// Once a pending approval part turns into an 'approved'/'denied' response,
		// automatically re-send so the run resumes without a second manual send
		// (matches the AI SDK's own useChat + toolApproval example).
		sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
	});

	const isBusy = status === "submitted" || status === "streaming";

	return (
		<Theme theme="g10">
			<Content>
				<Grid>
					<Column lg={16} md={8} sm={4}>
						<h1 className={styles.heading}>vaz-ai-next</h1>
						<p className={styles.tagline}>
							Vercel AI SDK × Next.js App Router × Zod — streaming chat demo
						</p>
					</Column>

					<Column lg={16} md={8} sm={4}>
						<div className={styles.messages} aria-live="polite">
							{messages.map((message) => (
								<Tile key={message.id} className={styles.message}>
									<strong className={styles.role}>{message.role === "user" ? "You" : "AI"}</strong>
									{message.parts.map((part, index) => {
										const key = `${message.id}-${index}`;
										return (
											<MessagePart
												key={key}
												part={part}
												onRespondToApproval={addToolApprovalResponse}
											/>
										);
									})}
								</Tile>
							))}
							{status === "submitted" && <InlineLoading description="考え中…" />}
							{error && (
								<InlineNotification
									kind="error"
									title="エラー"
									subtitle={error.message}
									lowContrast
								/>
							)}
						</div>
					</Column>

					<Column lg={16} md={8} sm={4}>
						<Form
							className={styles.form}
							onSubmit={(event) => {
								event.preventDefault();
								const text = input.trim();
								if (!text || isBusy) {
									return;
								}
								sendMessage({ text });
								setInput("");
							}}
						>
							<TextInput
								id="chat-input"
								labelText="メッセージ"
								hideLabel
								placeholder="メッセージを入力…(例: 東京の現在時刻は?)"
								value={input}
								onChange={(event) => setInput(event.target.value)}
								autoComplete="off"
							/>
							<Button type="submit" disabled={isBusy || input.trim() === ""}>
								送信
							</Button>
						</Form>
					</Column>
				</Grid>
			</Content>
		</Theme>
	);
}
