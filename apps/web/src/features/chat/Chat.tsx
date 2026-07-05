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
import type { UIDataTypes, UIMessagePart, UITools } from "ai";
import { useState } from "react";
import styles from "./Chat.module.scss";

function MessagePart({ part }: { part: UIMessagePart<UIDataTypes, UITools> }) {
	if (part.type === "text") {
		return <span className={styles.text}>{part.text}</span>;
	}
	// Tool calls (`tool-{name}`) are surfaced as a tag showing execution state.
	if (part.type.startsWith("tool-")) {
		const toolName = part.type.replace(/^tool-/, "");
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
	const { messages, sendMessage, status, error } = useChat();

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
									{message.parts.map((part, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: UIMessage parts have no stable ID and are only appended during streaming, so an index key is safe
										<MessagePart key={`${message.id}-${index}`} part={part} />
									))}
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
