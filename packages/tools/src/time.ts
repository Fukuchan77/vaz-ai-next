import type { AgentDeps } from "@vaz/schemas/deps";
import { tool } from "ai";
import { z } from "zod";

/**
 * Time capability (R1.4).
 *
 * Bundles the network-free `getCurrentTime` demo tool with its `deps` read from
 * closure. The current instant comes from `deps.now()` (an injected `Clock`)
 * instead of `new Date()`, so callers — and unit tests — can pin time
 * deterministically without ambient globals. Migrated behavior-equivalent from
 * the inline tool previously defined in the chat route (only the clock source
 * changed: `new Date()` → `deps.now()`).
 */
export function createTimeCapability(deps: AgentDeps) {
	const getCurrentTime = tool({
		description: "現在の日時を取得する。ユーザーが時刻・日付を尋ねたときに使う。",
		inputSchema: z.object({
			timeZone: z
				.string()
				.describe("IANA タイムゾーン名(例: Asia/Tokyo)。省略時は UTC。")
				.optional(),
		}),
		execute: async ({ timeZone }) => {
			const zone = timeZone ?? "UTC";
			return {
				timeZone: zone,
				now: new Intl.DateTimeFormat("ja-JP", {
					dateStyle: "full",
					timeStyle: "long",
					timeZone: zone,
				}).format(deps.now()),
			};
		},
	});

	return { getCurrentTime };
}
