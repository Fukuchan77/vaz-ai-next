# 001-vaz-ai-update — Discovery & Research Log

Created during `/sdd-plan`. Records investigations, decisions, and risks that
inform the design. Complements `gap-analysis.md` (`/sdd-validate-gap` output) —
this log adds the AI SDK 7 primitive verification and the architecture decisions
that shape `plan.md`.

## Discovery type

**New feature (full discovery).** Nature is greenfield-leaning brownfield: the
agent / RAG / workflow / observability surfaces are absent from the current code
(`grep`: `createChatAgent` / `drizzle` / `experimental_telemetry` /
`needsApproval` / `langfuse` / `inngest` → NONE FOUND), while the Phase 1 base
(env-driven provider, Zod boundaries, quality gates) is high-quality and
reusable. Discovery focused on (a) which requirements AI SDK 7 already satisfies
as first-class primitives, and (b) the single hard architectural question —
durability across worker restarts.

## Investigations

### AI SDK 7 agent primitives (grounds R1.3 / R1.4 / R1.6)

- **Question**: Does AI SDK 7 provide an agent abstraction, and how are typed
  deps injected — closure vs a first-class context mechanism?
- **Findings**: `ToolLoopAgent` (class, `import { ToolLoopAgent } from "ai"`)
  encapsulates model + instructions + tools + `stopWhen` and runs the tool loop.
  It accepts **two** context channels: `runtimeContext` (shared runtime state
  flowing through the loop, available in `prepareStep`, lifecycle callbacks, and
  results) and per-tool `toolsContext` validated by a tool's `contextSchema`
  (for server-side values such as credentials / scoped permissions). Default
  `stopWhen` is `isStepCount(20)`. → Design: keep construction-time infra deps
  (`db` / `logger` / `now`) in a **closure factory** `createChatAgent(deps)`,
  and pass request-scoped/sensitive values (`userId`, permissions, provider
  keys) via `runtimeContext` + `toolsContext`/`contextSchema`. This resolves the
  gap-analysis open question (closure vs runtimeContext) as **both, by role**.
- **Evidence**: `node_modules/ai/docs/03-agents/02-building-agents.mdx`;
  `node_modules/ai/docs/07-reference/01-ai-sdk-core/16-tool-loop-agent.mdx`;
  `ai@7.0.14`.

### Tool approvals & policy (grounds R3.4 / R3.5 / R5.3)

- **Question**: Is HITL approval a first-class contract, and can approval policy
  depend on runtime state (e.g. "turn is RAG-driven")?
- **Findings**: `ToolLoopAgent` takes `toolApproval` — a per-tool map, a
  per-tool `SingleToolApprovalFunction`, or a `GenericToolApprovalFunction`.
  Statuses: `'not-applicable'` | `'approved'` | `'denied'` | `'user-approval'`.
  `'user-approval'` emits a `tool-approval-request` instead of executing; the
  generic function receives `toolCall`, `tools`, `toolsContext`, `messages`,
  `runtimeContext`, so a policy can deny/gate destructive tools when
  `runtimeContext.externallyDriven === true` (lethal-trifecta guard, R5.3).
  `toolApproval` overrides a tool's `needsApproval` default and can be returned
  from `prepareCall` for per-request policy. **Important**: the SDK emits the
  approval *request/response* contract; the **durable suspend/resume across days
  (R3.5/R3.7/R3.8) is NOT provided** — that is the external engine's job.
- **Evidence**: `node_modules/ai/docs/03-agents/06-tool-approvals.mdx`;
  `.../06-policy-tool-approvals.mdx`; ToolLoopAgent `toolApproval` reference.

### Deterministic unit testing (grounds R1.6 / R4.4-tier1)

- **Question**: How are LLM-free deterministic agent tests written?
- **Findings**: `ai/test` exports `MockLanguageModelV4` (and
  `MockEmbeddingModelV4`, `mockValues`, `mockId`); `simulateReadableStream`
  (from `ai`) drives streaming without network. Note the exact name is
  `MockLanguageModelV4` (spec text says "MockLanguageModel" generically).
- **Evidence**: `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx`.

### OpenTelemetry → Langfuse (grounds R4.1-4.3 / NFR-7)

- **Question**: How is OTel enabled, and can it fail-soft?
- **Findings**: Install `@ai-sdk/otel`; call `registerTelemetry(new
  OpenTelemetry())` once at startup. For Next.js use `instrumentation.ts` with
  `registerOTel({ serviceName })` + `registerTelemetry`. Telemetry is
  **opt-out**: once an integration is registered, all AI SDK calls emit spans;
  attach metadata via `telemetry: { functionId }`, and set
  `recordInputs/recordOutputs: false` to suppress prompt/tool-IO capture
  (directly satisfies R4.7). Langfuse is wired as an OTLP exporter behind the
  OTel provider — **if the integration is simply never registered (missing
  config), AI SDK calls still run** (fail-soft, R4.3/NFR-4).
- **Evidence**: `node_modules/ai/docs/03-ai-sdk-core/60-telemetry.mdx`.

### Embeddings (grounds R2.3)

- **Question**: Is there an env-driven batch-embedding primitive?
- **Findings**: `embedMany({ model, values })` → `number[][]` (input order
  preserved), `embed` for single, `cosineSimilarity` for scoring. Model is a
  provider embedding model, so `resolveModel`'s env pattern extends cleanly to a
  `resolveEmbeddingModel(env)` (default Ollama `nomic-embed-text`).
- **Evidence**: `node_modules/ai/docs/03-ai-sdk-core/30-embeddings.mdx`;
  `.../31-reranking.mdx` exists but is deferred (R2.7).

### Workflow composition vs durability (grounds R3.2 / R3.3 / R3.7)

- **Question**: Do AI SDK workflows provide durability across worker restarts?
- **Findings**: AI SDK ships workflow **patterns** (sequential, parallel,
  orchestrator-worker, routing, evaluator-optimizer) and a `WorkflowAgent`, but
  execution is **in-process** — it does not survive a process restart or a
  multi-day suspend. → R3.7/R3.8 require an **external durable engine**. The
  design fixes the split: **AI SDK = typed composition/handoff + approval
  contract; external engine = durable execution, checkpointing, suspend/resume.**
  Engine choice (Inngest vs Temporal TS SDK) is deferred to the Phase 3 spike
  per Clarification Q2 — see ADR-2.
- **Evidence**: `node_modules/ai/docs/03-agents/03-workflows.mdx`;
  `.../07-workflow-agent.mdx`; `07-reference/04-ai-sdk-workflow/*`.

## Existing patterns to reuse

| Pattern | Location | Why reuse |
|---------|----------|-----------|
| Env-driven provider resolution | `src/lib/ai/provider.ts:13` | Canonical env→model pattern; extend to `resolveEmbeddingModel` (R2.3) and move into `@vaz/config`. |
| Zod env schema + empty→undefined | `src/lib/ai/env.ts:7` | NFR-3 basis; move to `@vaz/schemas`, extend for embedding/Langfuse/engine env. |
| `chatRequestSchema` (loose UIMessage) | `src/lib/ai/chat-schema.ts:8` | NFR-6 single-source-of-truth origin. |
| `streamText` + `tool()` + `stopWhen` | `src/app/api/chat/route.ts:33` | Behavior to preserve; wrap in `createChatAgent` (R1.5/1.7 no-regression). |
| `getCurrentTime` tool | `src/app/api/chat/route.ts:15` | Move to `@vaz/tools` capability; deps-closure the `execute` (R1.4). |
| Quality gates (Biome/Vitest/Playwright/hooks/CI/supply-chain) | root configs + `.githooks/` | NFR-1 non-degradation; adapt to `pnpm -r`/`--filter`. |

## External dependencies

| Dependency | Version | Purpose | Verified |
|------------|---------|---------|----------|
| `ai` | `7.0.14` (installed) | Agents, tools, telemetry, testing, embeddings | ✅ docs shipped in-package |
| `@ai-sdk/anthropic` / `@ai-sdk/react` / `@ai-sdk/openai-compatible` | `4.0.7 / 4.0.15 / 3.0.5` | Providers + `useChat` | ✅ installed |
| `@ai-sdk/otel` | latest (Phase 1) | OTel span collection for AI SDK | ⚠️ verify at install (`minimumReleaseAge` 24h) |
| `drizzle-orm` + `drizzle-zod` + `pg` | latest (Phase 2) | pgvector schema + typed access | ⚠️ `pg` may need `allowBuilds` audit |
| `@vercel/otel` + OTel SDK | latest (Phase 1) | Next.js `instrumentation.ts` | ⚠️ verify |
| Langfuse (self-hosted) + OTLP exporter | latest (Phase 1) | Trace/eval store | ⚠️ config-optional (fail-soft) |
| Inngest **or** Temporal TS SDK | TBD (Phase 3 spike) | Durable execution | ❓ ADR-2 spike decides |
| evalite **or** promptfoo | TBD (Phase 4) | LLM-as-judge harness | ❓ ADR-4 |

## Architecture decisions

### ADR-1: Phased monorepo (Hybrid), not big-bang

- **Context**: NFR-5 (backward-compatible phased migration), Clarification Q5
  (strict phase separation), NFR-1 (no quality-gate degradation).
- **Decision**: pnpm workspace `apps/{web,worker}` + `packages/{agents,tools,
  schemas,config,rag,evals}`. Phase 1 = skeleton + move web to `apps/web` +
  extract `agents/tools/schemas/config` at **behavioral parity**; later phases
  add `rag` / `worker` / `evals` as additive packages.
- **Alternatives**: (B) big-bang reconstruction — rejected: giant PR, regression
  risk, violates NFR-5; (C) delay monorepo, add agent layer inside `src/` —
  rejected: violates R1.1 (workspace mandatory).
- **Consequences**: The largest single change is the toolchain workspace-ization
  (tsconfig project references, Vitest projects, Playwright webServer, git hooks,
  supply-chain), all concentrated in Phase 1 (Integration Challenge #1–5).

### ADR-2: Durability = AI SDK composition + external engine (engine deferred to spike)

- **Context**: R3.7 (complete across worker restart), R3.8 (approve next day),
  R3.5 (resume from checkpoint). AI SDK workflows are in-process (verified).
- **Decision**: Split responsibilities — **AI SDK** owns typed multi-agent
  composition (supervisor→specialists) + `toolApproval` request/response
  contract; the **external durable engine** owns checkpointing, suspend/resume,
  retries, and worker-restart survival. The concrete engine (Inngest vs Temporal
  TS SDK) is chosen by a **Phase 3 opening spike** implementing "suspend for
  approval → resume next day" on both (Clarification Q2). BullMQ-only is excluded
  (self-built suspend/resume/HITL debt).
- **Alternatives**: single engine chosen now — rejected: premature per Q2;
  AI-SDK-only — rejected: cannot satisfy R3.7/R3.8.
- **Consequences**: `packages/schemas/workflows.ts` (typed handoffs) must be
  engine-agnostic so the spike outcome does not ripple into contracts.

### ADR-3: Deps injection by role — closure for infra, runtimeContext/toolsContext for request scope

- **Context**: R1.3 (`createChatAgent(deps)` typed `AgentDeps`), R1.4 (tools
  read deps from closure for mockability), R5.1 (tool execution scoped to user
  permissions via deps).
- **Decision**: `createChatAgent(deps: AgentDeps)` closes over infra
  (`db`, `logger`, `now`); request-scoped identity/permissions (`userId`, role,
  provider secrets) flow via AI SDK `runtimeContext` + per-tool `toolsContext`
  validated by `contextSchema`. Unit tests inject mock `AgentDeps` + a
  `MockLanguageModelV4`, no network (R1.6).
- **Alternatives**: everything via `runtimeContext` — rejected: infra like `db`
  is construction-time, not per-call; everything via closure — rejected: loses
  the SDK's typed per-call context and per-tool secret filtering.
- **Consequences**: `AgentDeps` type lives in `@vaz/schemas`; the `logger`
  contract encodes R4.7 (no raw prompts/tool-IO at INFO).

### ADR-4: OTel enabled from Phase 1, Langfuse fail-soft

- **Context**: NFR-7 (observability pulled forward to Phase 1 completion),
  R4.1-4.3, NFR-4.
- **Decision**: Register `@ai-sdk/otel` in `apps/web/instrumentation.ts` from
  Phase 1; enrich spans with `functionId` + `jobId`/`userId`/agent name
  (R4.2); set `recordInputs/recordOutputs:false` by default (R4.7). Langfuse
  OTLP export initializes only when env is present; missing config logs one
  warning and does not register the exporter (fail-soft, R4.3).
- **Alternatives**: add OTel in Phase 4 — rejected by NFR-7 (debugging leverage
  for phases 2/3).
- **Consequences**: `@vaz/config` gains a telemetry-init module reused by both
  `apps/web` and `apps/worker`.

### ADR-5: `forbid-hardcoded-model-ids` as a CI grep gate (Biome plugin as stretch)

- **Context**: R1.8 (lint fails if a model ID is hardcoded), NFR-3.
- **Decision**: Ship a deterministic **CI + pre-commit grep gate** matching
  model-ID literals (e.g. `claude-`, `llama3`) outside `@vaz/config`/env, wired
  as a mise task. A Biome 2.5 custom plugin is a later enhancement, not a Phase 1
  blocker.
- **Alternatives**: Biome plugin only — rejected: higher upfront cost/uncertain
  API; runtime check — rejected: R1.8 requires a lint-stage failure.
- **Consequences**: One allow-list location (`@vaz/config`) for legitimate
  default IDs.

## Risks & open questions

- ⚠️ **Toolchain workspace-ization is the top integration risk** (Integration
  Challenge #1–5): tsconfig → project references / `pnpm -r`; Vitest → projects
  (web=jsdom, agents/rag=node) with per-package coverage; Playwright webServer →
  `--filter @vaz/web`; git hooks bare `pnpm exec` → `pnpm -r`/mise. Mitigation:
  do it first in Phase 1 with behavior-parity E2E as the gate.
- ⚠️ **Native deps & supply chain** (`pg`, workflow engine, sharp, OTel): any
  with install scripts must be added to `allowBuilds` (default deny) and pass
  `minimumReleaseAge` (24h). Mitigation: audit at each package addition (R1.2).
- ⚠️ **React Compiler boundary**: `reactCompiler:true` is web-only; do not enable
  in Node library packages. Mitigation: `@vaz/config` base tsconfig excludes it.
- ❓ **Durable engine choice (Inngest vs Temporal)** — resolve in Phase 3 spike
  (ADR-2 / Q1).
- ❓ **Embedding dimension per provider** (Ollama `nomic-embed-text` 768 vs
  OpenAI 1536): pgvector column dimension must be config-driven — resolve in
  Phase 2 (R2.2/2.3).
- ❓ **Eval harness (evalite vs promptfoo)** and nightly cost cap — resolve in
  Phase 4 (ADR-4 / R4.4/4.6).
- ❓ **IdP integration method** (Auth.js vs internal standard) — deferred to
  Phase 5 start (Clarification Q5 / R5.1); the deps-permission-scoping constraint
  holds regardless.

---

_Research generated: 2026-07-04_
