# Acceptance evidence (MAST-40 / M5)

Last updated: 2026-11-25.

## Deterministic suites (automated)

| Suite | Command | Coverage |
| --- | --- | --- |
| Policy | `npm run test:policy` | Permissions, delegation, queue, timeout, worker selection |
| Context | `npm run test:context` | Memory isolation, conversations, handoff, task store |
| Signals | `npm run test:signals` | Intake ledger dedupe, reconcile |
| Acceptance | `npm run test:acceptance` | Restart/interruption + intake dedupe |
| Plantool tools | `npm run test:plantool` | Planning CLI wrappers |
| Local lookup | `tests/tools/local-lookup.test.mjs` | Bounded search/read, scope isolation |
| Typecheck | `npm run check` | TypeScript |

## Scenario mapping

- **Permission denial / expiry** — `tests/policy/delegation.test.mjs`
- **User question resume** — `tests/policy/worker-registry.test.mjs`
- **Cancellation / timeout / FIFO** — `tests/policy/task-registry.test.mjs`
- **Cross-project memory isolation** — `tests/context/memory-store.test.mjs`, `tests/context/project-isolation.test.mjs`
- **Interrupted task without replay** — `tests/context/task-store.test.mjs`, `tests/acceptance/vertical-slice.test.mjs`
- **Worker notifications** — `src/signals/worker-bridge.ts` + `npm run test:signals`

## Live worker smoke (opt-in)

Set `RUN_ACP_PROVIDER_TESTS=1` and run `npm run test:acp:providers`. Requires authenticated Codex/Cursor/Claude environments. Record pass/fail per machine in the table below.

| Worker | Date | Result | Notes |
| --- | --- | --- | --- |
| Codex | — | not run in CI | User machine |
| Cursor | 2026-11-25 | pass | `d9ad749`, agent ACP on Windows |
| Claude | 2026-11-25 | pass | User-confirmed ACP after login |

## User pilot (manual)

Ten representative tasks spanning planning lookup, delegation, correction, and interruption remain **open** for formal recording. Use this file to append dated rows with task ID, interventions, and outcome.