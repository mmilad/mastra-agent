# Architecture decisions: Mastra vs portable core

Last updated: 2026-11-25 (unified runtime / Studio parity)

## Portable (keep if leaving Mastra)

| Component | Location | Notes |
| --- | --- | --- |
| Intake ledger + dedupe | `src/signals/intake-ledger.ts`, `intake-service.ts` | Framework-agnostic envelope contract |
| Task registry + ACP | `src/mastra/tools/task-registry.ts`, `src/integrations/acp/` | Authoritative worker lifecycle |
| Workspace permission policy | `src/policy/workspace.ts` | ACP approval boundaries |
| Approval utterance routing | `src/policy/approval-utterance.ts`, `approval-routing.ts` | “approve it”, auto-approve in workspace |
| Supervisor triage (heuristic + LLM) | `src/supervisor/` | Small state machine; replaceable |
| Scoped memory store | `src/context/memory-store.ts` | Project/user facts outside Mastra thread memory |

## Mastra-specific (rebuild or drop if leaving)

| Component | Notes |
| --- | --- |
| `mastra dev` Studio UI | Replace with custom WebUI calling `POST /v1/chat` |
| `agent.generate` / signals / notifications | Thread delivery; custom host needs PubSub + storage |
| `Mastra` workflows | `supervisor-routing`, `knowledge-answer` — replicable as plain functions |
| Tool execution context (`context.agent` stub) | Custom runtime should pass full handles |
| LibSQL via `@mastra/libsql` | Could keep SQLite schema or migrate |

## Studio parity (2026-11-25)

Studio user messages call `acceptAndDispatch` with `syncReply: true` and `studioInlineDispatch: true` ([`src/signals/studio-intake.ts`](../../src/signals/studio-intake.ts)). Reconcile skips in-flight duplicate dispatch ([`src/signals/intake-service.ts`](../../src/signals/intake-service.ts)).

## External UI contract

- `POST /v1/chat` — `{ text, threadId, sync? }` ([`src/signals/chat-api.ts`](../../src/signals/chat-api.ts))
- `POST /signal-intake` — full envelope ([`src/signals/http-intake.ts`](../../src/signals/http-intake.ts))

## Aspect (ProjectPlanner)

Separate repo: graph/plan SoT, MCP for planning. This assistant may call Plantool tools or MCP later; worker execution stays in mastra-agent ACP until Aspect hosts workers.

## Environment flags

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASSISTANT_TOOL_PROFILE` | `full` | `minimal` drops plantool/memory/skills tools |
| `TASK_AUTO_APPROVE_IN_WORKSPACE` | on | In-workspace delegated permissions |
| `WORKER_FOLLOWUP_GENERATE` | on | Summary turn after terminal worker_response |