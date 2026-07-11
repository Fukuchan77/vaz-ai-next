import type { AgentDeps } from "@vaz/schemas/deps";
import type { ToolExecutionStartEvent } from "ai";
import { createAuditHook } from "../src/audit-hook";

/**
 * Unit tests for `createAuditHook` (R5.5): the single `@vaz/agents` firing
 * point that turns a tool-execution SDK event into a `deps.audit.record(...)`
 * call. Pure / network-free — no model, no DB; `deps.audit` is a fake sink.
 */

function toolExecutionStartEvent(toolName: string, input: unknown): ToolExecutionStartEvent {
	return {
		callId: "call-1",
		messages: [],
		toolContext: undefined,
		toolCall: {
			type: "tool-call",
			toolCallId: "tc-1",
			toolName,
			input,
			dynamic: false,
		},
	} as ToolExecutionStartEvent;
}

function makeDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
	return {
		db: null,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		now: () => new Date("2026-01-02T03:04:05Z"),
		...overrides,
	};
}

describe("createAuditHook — firing point (R5.5)", () => {
	test("is a no-op when deps.audit is omitted (Phase 1 allowed)", async () => {
		const hook = createAuditHook(makeDeps());

		await expect(
			hook.onToolExecutionStart(toolExecutionStartEvent("getCurrentTime", {})),
		).resolves.toBeUndefined();
	});

	test("records tool/args/ts from the event and clock, userId/jobId null by default", async () => {
		const record = vi.fn().mockResolvedValue(undefined);
		const now = new Date("2026-03-04T05:06:07Z");
		const hook = createAuditHook(makeDeps({ audit: { record }, now: () => now }));

		await hook.onToolExecutionStart(
			toolExecutionStartEvent("getCurrentTime", { timeZone: "Asia/Tokyo" }),
		);

		expect(record).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith({
			userId: null,
			jobId: null,
			tool: "getCurrentTime",
			args: { timeZone: "Asia/Tokyo" },
			ts: now,
		});
	});

	test("threads deps.runtimeContext.userId and options.jobId through the entry", async () => {
		const record = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({
			audit: { record },
			runtimeContext: { userId: "user_1", role: "member" },
		});
		const hook = createAuditHook(deps, { jobId: "11111111-1111-1111-1111-111111111111" });

		await hook.onToolExecutionStart(toolExecutionStartEvent("searchDocuments", { query: "q" }));

		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user_1",
				jobId: "11111111-1111-1111-1111-111111111111",
			}),
		);
	});

	test("catches a sink failure and logs correlation only — never raw args (R4.7)", async () => {
		const record = vi.fn().mockRejectedValue(new Error("db down"));
		const error = vi.fn();
		const deps = makeDeps({
			audit: { record },
			logger: { debug() {}, info() {}, warn() {}, error },
		});
		const hook = createAuditHook(deps);

		await expect(
			hook.onToolExecutionStart(
				toolExecutionStartEvent("sendEmail", { to: "a@b.com", body: "secret" }),
			),
		).resolves.toBeUndefined();

		expect(error).toHaveBeenCalledTimes(1);
		const [message, fields] = error.mock.calls[0] as [string, Record<string, unknown>];
		expect(message).toContain("audit");
		expect(fields).not.toHaveProperty("args");
		expect(JSON.stringify(fields)).not.toContain("secret");
	});
});
