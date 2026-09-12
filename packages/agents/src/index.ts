/**
 * `@vaz/agents` public surface (R1.3): the single entry point through which
 * consumers (e.g. `apps/web`'s chat route) obtain the agent core.
 * Consumers import from `@vaz/agents/index` rather than reaching into
 * individual modules. Phase 3+ additions (`supervisor`, `approval-policy`) are
 * re-exported alongside the chat agent as they land.
 *
 * `AgentDeps` is re-exported from its single source of truth (`@vaz/schemas`,
 * the dependency-graph leaf) so callers obtain the agent factory and its
 * dependency contract from one entry point (plan public interface).
 */

export type { AgentDeps } from "@vaz/schemas/deps";
export type {
	ApprovalToolCall,
	CreateToolApprovalPolicyOptions,
	ToolApprovalPolicy,
	ToolApprovalPolicyInput,
} from "./approval-policy";
export {
	createToolApprovalPolicy,
	UNVERIFIABLE_APPROVAL_DENIAL_REASON,
} from "./approval-policy";
export { resolveApprovalSigningKey } from "./approval-signing";
export type { ChatAgent, ChatAgentStreamOptions, CreateChatAgentOptions } from "./chat-agent";
export { createChatAgent } from "./chat-agent";
export type {
	CreateSupervisorWorkflowOptions,
	DispatchContext,
	JobEventSink,
	Specialist,
	SpecialistRegistry,
	SupervisorWorkflow,
	WorkflowStepRunner,
} from "./supervisor";
export { createSupervisorWorkflow, SpecialistUnavailableError } from "./supervisor";
