# Resume and approval across turns (MAST-69)

## Worker lifecycle → signals

`wireWorkerTaskSignals` maps task registry updates to intake envelopes:

| Task status | Signal category | Notes |
| --- | --- | --- |
| `waiting_approval`, `waiting_input` | `worker_progress` | Coalesced per task; surfaces in notification inbox |
| `completed`, `failed`, `cancelled`, `interrupted` | `worker_response` | Terminal dedupe key prevents replay |

Threads must be subscribed (`ensureThreadSubscribed`) before notifications dispatch.

## User resume paths

1. **Explicit approval** — User message contains `approve it`, `go ahead`, `approve <token>`, `approve <taskId>`, `deny it`, or `answer <token>: …` → assistant or Studio fast-path calls `resolve-task-approval`. In-workspace delegated permissions may auto-approve unless `TASK_AUTO_APPROVE_IN_WORKSPACE=false`.
2. **Status check** — User asks for task status → `get-task-status` only; no new worker.
3. **Supervisor follow-up** — Terminal or approval notifications wake the thread; user sends the next prompt through the intake ledger (chat CLI or HTTP).

## Supervisor

Notification delivery does **not** auto-start a new worker. The supervisor workflow runs on the next **user_prompt** or configured auto-follow-up (future MAST-67 process can enqueue a summarize prompt after terminal worker events).

## Unrouted worker events

Tasks created without `conversationId` produce **unrouted** ledger rows. Operator:

```sh
npm run intake -- list unrouted
npm run intake -- resolve <eventId> <conversationId>
```

No broadcast to all threads.