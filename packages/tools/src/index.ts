/**
 * `@vaz/tools` public surface (R1.4): the aggregation point for capability
 * factories. Each capability bundles one or more `tool(...)` definitions whose
 * `execute` reads runtime concerns from an injected `AgentDeps` closure.
 * Consumers (e.g. `@vaz/agents#createChatAgent`) import capabilities from here
 * rather than reaching into individual modules. Phase 3+ capabilities
 * (`email`, `allowlist`) are re-exported alongside `time` as they land.
 */
export type {
	CreateEmailCapabilityOptions,
	EmailTransport,
	SendEmailInput,
	SendEmailResult,
} from "./email";
export { createEmailCapability, sendEmailInputSchema } from "./email";
export { createTimeCapability } from "./time";
