# Signal-first long-running assistant (M6)

Target experience: a **DOT / Grokbot-style** local supervisor — always on, conversation-aware, able to **research**, **delegate** long work to ACP workers, **resume** after interruption, and **propose** new skills or workflows when patterns repeat. **Signals are the front door**; the **supervisor workflow** decides what happens next (not ad-hoc tool sprawl in the prompt).

## Principles

1. **All durable ingress** goes through the intake ledger (`docs/mastra-signals.md`), then Mastra APIs (`sendMessage`, `queueMessage`, `sendNotificationSignal`).
2. **Task store** remains authoritative for worker lifecycle; **notifications** inform the thread only.
3. **Supervisor workflow** is the single routing brain: triage → answer | research | delegate | queue | notify user.
4. **Plantool** records goals, new workflows/skills proposals, and shipped evidence.

## Architecture (target)

```
[User / Studio / Webhook / Worker] 
        → Intake ledger (dedupe, route)
        → Mastra Signals (per thread)
        → Supervisor workflow (triage)
              ├─ direct answer (model + tools)
              ├─ research workflow (knowledge, lookup, optional web later)
              ├─ delegate workflow → task registry → ACP workers
              └─ queue / defer (queueMessage, notification summarize)
        → Outbound: thread history + notification inbox + plantool updates
```

## Phases and Plantool tickets

| Phase | Focus | Tickets |
| --- | --- | --- |
| A | Signals front door | MAST-60–63 |
| B | Supervisor workflow | MAST-64–66 |
| C | Long-running runtime & resume | MAST-67–69 |
| D | Research & invention | MAST-70–71 |
| E | External ingress & ops | MAST-72–73 |
| F | End-to-end verification | MAST-74 |

## Boundaries

- **M6 does not** replace M3 task queue semantics or M4 tools; it **orchestrates** them.
- **Multi-process PubSub** stays a later gate (after single-process signal + supervisor loop is boring).
- **Proactive scheduling** (cron, unsolicited outreach) is post-pilot; design hooks only in workflow.

## Success criteria (M6 feature)

- User prompt in Studio enters via ledger and wakes the thread reliably.
- Worker completion surfaces as notification and yields a supervisor follow-up without duplicate dispatch.
- Supervisor workflow chooses delegation for file-changing requests; research for doc questions; plain answer for small talk.
- Process restart reconciles pending intake; failed rows are inspectable.
- At least one documented path to **propose** a new workflow or skill into plantool from a repeated pattern.

References: `docs/mastra-signals.md`, `docs/pilot/acceptance-evidence.md`, Mastra [Signals](https://mastra.ai/docs/signals/overview), [Workflows](https://mastra.ai/docs/workflows/overview).