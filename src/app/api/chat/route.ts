import {
	convertToModelMessages,
	createUIMessageStreamResponse,
	isStepCount,
	streamText,
	tool,
	toUIMessageStream,
	type UIMessage,
} from "ai";
import { z } from "zod";
import { chatRequestSchema } from "@/lib/ai/chat-schema";
import { resolveModel } from "@/lib/ai/provider";

/** Network-free demo tool — illustrates runtime validation via a Zod inputSchema. */
const getCurrentTime = tool({
	description: "現在の日時を取得する。ユーザーが時刻・日付を尋ねたときに使う。",
	inputSchema: z.object({
		timeZone: z.string().describe("IANA タイムゾーン名(例: Asia/Tokyo)。省略時は UTC。").optional(),
	}),
	execute: async ({ timeZone }) => {
		const zone = timeZone ?? "UTC";
		return {
			timeZone: zone,
			now: new Intl.DateTimeFormat("ja-JP", {
				dateStyle: "full",
				timeStyle: "long",
				timeZone: zone,
			}).format(new Date()),
		};
	},
});

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
	}

	const parsed = chatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return Response.json(
			{ error: "Invalid chat request", issues: parsed.error.issues },
			{ status: 400 },
		);
	}

	const result = streamText({
		model: resolveModel(),
		messages: await convertToModelMessages(parsed.data.messages as UIMessage[]),
		tools: { getCurrentTime },
		// Let the model keep generating after a tool call (up to 5 steps).
		stopWhen: isStepCount(5),
	});

	return createUIMessageStreamResponse({
		stream: toUIMessageStream({ stream: result.stream }),
	});
}
