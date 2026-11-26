# Prompt ingest contract (MAST-98)

Status: **Phase A implemented** (heuristic kinds, no ledger fan-out). Decisions: **MAST-85** (Assistant-only user voice), **MAST-96** (phased ingest → decompose → map to branches).

## Placement

```
signal intake ledger (dedupe, thread)
  → supervisor-routing workflow
      1. prompt-ingest     ← kinds, compound, subIntents
      2. supervisor-triage ← branch (answer | research | delegate)
      3. supervisor-execute
```

Ingest **does not** replace the ledger. It **understands** the user message before execution routing.

## Prompt kinds

| Kind | Signals (heuristic v1) | Default branch |
| --- | --- | --- |
| `social` | hi, thanks, short pleasantries | `answer` |
| `general_qa` | default when no project signal | `answer` |
| `project_research` | explain, documented, lookup, … | `research` |
| `project_task` | edit/create file/code, delegate worker | `delegate` |
| `planning` | plantool, roadmap, ticket, backlog | `answer` (+ plantool tools) |
| `ops` | approve, cancel, task status | `answer` (+ task tools) |
| `compound` | research **and** task (or split clauses) | per `subIntents[]` |

Kinds describe **intent**; branches describe **execution pipeline**. One message can have multiple kinds; `primaryKind` picks logging and future hints.

## Phase A output schema

```ts
{
  kinds: PromptKind[];
  primaryKind: PromptKind;
  compound: boolean;
  subIntents: { text: string; kinds: PromptKind[]; suggestedBranch?: 'answer'|'research'|'delegate' }[];
  ingestSource: 'heuristic' | 'llm';
}
```

**Phase A rules**

- Heuristic only (`src/supervisor/prompt-ingest.ts`).
- **No** child `user_prompt` events on the ledger.
- Triage step unchanged; ingest is observable in workflow traces and (MAST-80) ledger metadata later.
- `subIntents` populated when compound detected; split on ` and ` / `;` only when halves map to **different** branches.

## Phase B (MAST-99) — decompose

- LLM ingest with JSON schema; confidence score.
- Fan-out on ledger only when `compound && confidence >= threshold` and sub-intents are non-overlapping.
- Otherwise Assistant single turn acknowledges plan (still MAST-85).

## Phase C — sequential dispatch

- Reconcile runs sub-intents in order; dedupe keys per sub-event.
- Requires MAST-81 golden suite for compound cases.

## User-visible speech

Only the **Assistant** agent produces thread replies. Ingest, triage, `knowledge-answer`, and workers are internal.

## Code

| File | Role |
| --- | --- |
| `src/supervisor/prompt-kinds.ts` | Kind enum + branch hints |
| `src/supervisor/prompt-ingest.ts` | Phase A heuristic ingest |
| `src/mastra/workflows/supervisor-routing.ts` | `prompt-ingest` workflow step |
| `tests/supervisor/prompt-ingest.test.mjs` | Heuristic tests |

Parent contract: `docs/supervisor-workflow-contract.md`. Backlog: `docs/supervisor-improvement-backlog.md`.