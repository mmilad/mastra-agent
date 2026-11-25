# M6 acceptance evidence (MAST-59)

Date: 2026-11-25

## Success criteria

| Criterion | Evidence |
| --- | --- |
| User prompt in Studio enters via ledger | `wrapAssistantSignalIntake` on assistant in `src/mastra/index.ts`; `tests/signals/studio-intake.test.mjs` |
| Chat / HTTP use ledger + supervisor | `src/run.ts`, `dispatch.ts`, `tests/signals/dot-loop.test.mjs` |
| Worker completion → notification, no duplicate | `dot-loop.test.mjs` dedupe; `worker-bridge.ts` |
| Supervisor branch selection | `tests/supervisor/triage.test.mjs`; workflow `supervisor-routing` |
| Restart reconcile + inspect failed/pending | `npm run supervisor`, `npm run intake`; `docs/operator-signal-intake.md` |
| Propose skill/workflow to Plantool | `propose-skill-or-workflow` tool |

## Commands (green locally)

```sh
npm run test:signals
npm run test:supervisor
npm run check
```

## Triage

- **MAST-75** decided: **LLM triage** (`triageUserPromptWithLlm`) with regex fallback; force heuristic via `SUPERVISOR_TRIAGE_HEURISTIC_ONLY=1` in CI.

## Known gap

Studio records intake and triage metadata but does not run the full `supervisor-routing` workflow on stream without risking duplicate agent runs. Chat CLI and HTTP `user_prompt` dispatch are the reference paths.