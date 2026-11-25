# Supervisor triage workflow contract (MAST-64)

Status: v1 implemented as `supervisor-routing` Mastra workflow; triage uses **local LLM** (`supervisor-triage` agent) with **regex fallback** on failure or `SUPERVISOR_TRIAGE_HEURISTIC_ONLY=1`.

## Purpose

User and routed prompts enter through the intake ledger, then **supervisor routing** chooses how the assistant acts. The workflow is the single routing brain; tools remain executors (delegate-task, knowledge, lookup).

## Inputs

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `text` | string | yes | User message body (1–16k chars) |
| `resourceId` | string | yes | Workspace `workspaceId` from intake |
| `threadId` | UUID | yes | Conversation id |
| `syncReply` | boolean | no | `true` for blocking CLI; default async (`sendMessage`) for Studio/HTTP |

Intake `user_prompt` payload mirrors `text` and optional `syncReply`.

## Outputs

| Field | Type | Notes |
| --- | --- | --- |
| `branch` | `answer` \| `research` \| `delegate` | Chosen route |
| `delivered` | boolean | Mastra signal APIs were invoked |
| `responseText` | string | Present when `syncReply` and model returned text |

## Branch table

| Branch | When (LLM + heuristic fallback) | Execution |
| --- | --- | --- |
| **answer** | Default; small talk; general questions | `sendMessage` / `generate` with user text |
| **research** | Doc/knowledge phrasing (`explain`, `documented`, `lookup`, …) | Run `knowledge-answer` workflow, then deliver lookup context to the thread |
| **delegate** | File/code change verbs + targets, or explicit delegate | Async: `sendMessage` with delegate routing hint; sync: same via `generate` (agent calls `delegate-task`) |

## Mastra steps

1. `supervisor-triage` — `triageUserPromptWithLlm(text)` → branch label (`llm` or `heuristic`)
2. `supervisor-execute` — branch executor (`executeSupervisorTurn`)

Registered on `Mastra` as `supervisorRouting`; invoked from `dispatchEnvelope` for `user_prompt` and via `runSupervisorRouting()`.

## Related workflows

| Workflow | Role |
| --- | --- |
| `knowledge-answer` | Research branch backend |
| *(future)* `delegate-handoff` | Structured worker brief assembly |
| *(future)* `propose-plantool-skill` | MAST-71 invention path |

## Product decisions

1. **Triage model** — **MAST-75 → MAST-77**: LLM triage with regex fallback (see `src/supervisor/llm-triage.ts`).
2. **Research delivery** — v1 queues knowledge text then sends user message; alternative is single merged assistant turn only.
3. **Studio sync** — Studio stays async-only; whether CLI is the only `syncReply` consumer.
4. **Unrouted events (MAST-63)** — Default activity thread vs. operator-only resolution (no broadcast).
5. **Long-running entry (MAST-67)** — `mastra dev` only vs. dedicated supervisor process/systemd.

Plantool feature: **MAST-59**; implementation tickets **MAST-60–66** (this contract unblocks **65–66**).