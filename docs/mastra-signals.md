# Workspace-scoped signal intake

Status: design for the local-first assistant; checked against installed `@mastra/core` 1.85.0 on 2026-11-24.

## Decision

Use Mastra Signals as the thread input and delivery layer. Keep an application-owned intake boundary responsible for authentication, validation, routing, durable acceptance, and event-idempotency. Keep `assistant-tasks.db` authoritative for worker task state, approvals, cancellation, and side-effect reconciliation. Mastra notification records are an event inbox for assistant delivery, not the worker task ledger.

The current application is a single local process with LibSQL conversation storage. The default in-process PubSub is sufficient only while one process owns a given thread. A multi-process deployment must add a shared PubSub implementation with thread leases and shared storage before allowing two instances to serve the same workspace/thread.

## Normalized intake envelope

Every adapter validates and converts incoming data to this application envelope before calling Mastra:

```ts
type IntakeEnvelope = {
  schemaVersion: 1;
  eventId: string;                 // stable producer ID or generated UUID persisted before dispatch
  category: 'user_prompt' | 'worker_response' | 'worker_progress' | 'ci_run' | 'external_event';
  workspaceId: string;             // opaque internal ID; never trusted directly from an unauthenticated body
  conversationId?: string;          // required for user prompts; optional only when routing policy is unambiguous
  occurredAt: string;               // ISO timestamp from producer, separately retain receivedAt
  receivedAt: string;
  producer: { kind: 'user' | 'worker' | 'github' | 'system'; id: string };
  correlationId?: string;           // usually the application task ID for worker events
  sequence?: number;                // monotonic within a producer/task where available
  dedupeKey: string;                // producer + eventId; stable across retries
  payload: Record<string, unknown>; // category-specific, size-limited, schema-validated
};
```

The intake layer rejects unknown schema versions, invalid IDs, oversized bodies, invalid timestamps, and payloads that fail the category schema. It stores the validated envelope (or a durable reference to it) before acknowledging an event whose loss is unacceptable. Secrets, credentials, raw authorization headers, and arbitrary executable content are excluded from the model-facing summary and payload.

## Routing identity

- `resourceId` is the stable internal `workspaceId`, not the repository path, provider account, or user-controlled external resource string. This scopes memory and thread ownership to a workspace.
- `threadId` is the stable internal `conversationId`. A workspace can have many conversations, so workspace alone must never select a thread implicitly for user prompts.
- User prompts require an explicit conversation ID, or an authenticated UI/session binding that resolves exactly one conversation. If absent or ambiguous, return a validation error; do not broadcast to every thread.
- Worker task events carry `correlationId`/task ID. The task store records the originating conversation ID at task creation; intake resolves the event through that task record. If no target conversation is known, route to a designated workspace activity conversation only if one is explicitly configured. Otherwise persist the event as unrouted for later resolution and do not guess.
- External resources (for example GitHub repository IDs) map through a server-side subscription table to `workspaceId` and optionally `conversationId`. Never accept arbitrary Mastra `resourceId` or `threadId` from a webhook payload.

## Mapping to Mastra 1.85.0

| Category | Mastra API | Model visibility and durable data |
| --- | --- | --- |
| `user_prompt` | `agent.sendMessage()` for an immediate user turn; `agent.queueMessage()` when it must wait until the active answer finishes | User message is part of thread history. Authenticate the author and attach the verified author, not a payload-supplied identity. |
| `worker_response` | `agent.sendNotificationSignal()` with `source: 'worker'`, `kind: 'task-result'`, stable `dedupeKey`, `correlationId` attribute/metadata and bounded summary/payload | Notification record is durable when the configured storage supports notifications. Delivered model signal includes summary and notification metadata/record ID, not the full stored payload. Use the notification inbox tool's `read` action for the full record. |
| `worker_progress` | `sendNotificationSignal()` for meaningful state changes; coalesce noisy progress by task/stage using a stable `coalesceKey`. Use `queueSignal()` only for intentionally ordered, non-durable thread context | Notification inbox persists; coalescing replaces latest summary/payload and increments count. Never let progress updates mutate task truth outside the task store. |
| `ci_run` | `sendNotificationSignal()` with `source: 'ci'`, event kind, stable provider event ID as dedupe key; coalesce only repetitive statuses for the same run where the latest replaces earlier pending updates | Inbox record persists. Model receives summary on delivery and reads the detailed payload by inbox record ID. CI event IDs and run URLs are validated and sanitized. |
| `external_event` | `sendNotificationSignal()` for durable events; `queueSignal({type:'reactive'|'state', ...})` only for short-lived or explicitly maintained thread context | Reactive input is not an inbox. State signals persist versioned thread context but are not a replacement for raw event history. |

Use Mastra's notification inbox tool (exported as `createNotificationInboxTool({ storage })` in the installed package) when adding model access to stored payloads. Scope inbox operations to the current trusted resource/thread; do not let the model choose another workspace's `threadId`. Current assistant does not yet register this tool, so full payload visibility is a follow-on implementation requirement.

## Ordering, idempotency, and delivery

- Mastra `sendMessage`, `queueMessage`, and `queueSignal` coordinate input per thread. `queueMessage`/`queueSignal` are ordered behind the current run; Mastra owns that runtime queue. Do not infer ordering across threads or across unrelated producers.
- The durable intake ledger owns deduplication across HTTP retries and restarts. Enforce uniqueness on `(producer, dedupeKey)`; record accepted/routed state and the target IDs. The Mastra notification `dedupeKey` complements this ledger but does not replace it.
- Use `coalesceKey` only when newer pending data semantically supersedes older pending data. Do not coalesce task completion/failure transitions or distinct CI runs.
- Notifications have policy choices (`deliver`, `queue`, `summarize`, `defer`, `persist`, `discard`) and retry delivery; a failed delivery is retried and capped at five attempts in the installed implementation. `sendNotificationSignal()` is durable only with notification-capable storage. The LibSQL store is the intended local backend, but verify notification-domain support with an integration test before enabling notification intake.
- Ordinary Mastra runtime queues are in-memory and are lost on a process crash. `ifIdle.behavior: 'persist'` stores a signal in memory storage but does not make it an application-owned durable ingress log. Persist high-value input in the intake ledger first, then dispatch; on restart, reconcile accepted-but-not-delivered rows and retry with the same event/dedupe key.
- Mastra signals and PubSub are at-least-once under retries/redelivery, not exactly-once. Consumers and task side effects must be idempotent. The task store prevents automatic worker replay after an interrupted run; re-delivering a notification must never dispatch the worker again.
- For a single local process, use the default `EventEmitterPubSub`. For multiple processes, configure the same durable storage and a shared PubSub that supports both cross-process delivery and thread leases (the current docs recommend Redis/Valkey Streams for multi-host). Google Cloud Pub/Sub alone transports events but does not provide Mastra thread leases.
- Enforce one active write task per workspace in the existing application worker registry. Signal delivery does not relax that limit. In a multi-process deployment, the task-store lease/transaction must be shared and atomic; Mastra thread leases protect conversation writers, not task execution slots.

## Failure and crash boundaries

1. Authenticate and validate the request.
2. Insert the normalized envelope into the intake ledger with unique dedupe key and resolved target (or `unrouted`). Commit.
3. Return accepted only after the durable insert. A duplicate returns the existing event receipt.
4. Dispatch to the selected Mastra API using stable resource/thread IDs and a stable notification dedupe key.
5. Record the Mastra delivery decision and retry metadata in the intake ledger. A crash between steps 4 and 5 is safe because dispatch is retried idempotently.
6. A separate reconciler retries pending events after restart with bounded backoff and exposes permanently failed items for inspection.

The ledger records producer event sequence where available and detects sequence gaps. Do not block all later events on one missing sequence unless that producer's contract requires strict ordering; instead persist gap metadata and surface it. The thread queue orders accepted inputs within that thread, while task state remains authoritative for lifecycle.

## Endpoint security

- User-facing intake requires the application's authenticated local session/token and derives workspace/conversation access from server-side authorization. Bind tokens to the local user/session; reject cross-workspace IDs.
- Provider webhooks verify signatures over the exact raw request bytes, enforce timestamp tolerance and constant-time signature comparison, validate configured provider/account/repository subscriptions, cap body size, and reject unsupported content types before parsing.
- Use event ID plus signature timestamp for replay detection, with the durable unique dedupe constraint as the final guard. Do not treat a valid signature as authorization to choose arbitrary internal workspace/thread IDs.
- Keep webhook secrets in environment/OS secret storage; never log them or include them in notification payloads. Sanitize summaries to prevent control-character/log injection. Treat model-facing event content as untrusted data, not instructions.
- Rate-limit per credential/provider and workspace; bound per-workspace pending intake and return retryable status when capacity is exceeded. Keep the handler fast: durable acceptance only, with dispatch through a worker/reconciler.

## Boundary with MAST-33 / MAST-34

MAST-33 remains the source of truth for durable worker task states, approvals, interruption recovery, and the rule that an uncertain interrupted task is not automatically rerun. MAST-34 remains the source of truth for workspace task queue/lease limits, preflight, timeout/cancellation ownership, and evidence. The intake ledger owns only inbound event receipt, validation, deduplication, target routing, and dispatch status. Mastra owns conversation history, per-thread signal delivery, and notification inbox records. No system derives worker task status from a notification record, and no notification retry starts a worker side effect.

## Installed-version verification

Inspected `node_modules/@mastra/core/dist/agent/signals.d.ts`, `agent/agent.d.ts`, `notifications/types.d.ts`, `notifications/tool.d.ts`, `signals/webhook-signal-provider.d.ts`, and the runtime implementation in `agent-controller-*.js`. The installed version is exactly 1.85.0. It provides `sendMessage`, `queueMessage`, `queueSignal`, typed signal categories (`user`, `state`, `reactive`, `notification`), notification `dedupeKey`/`coalesceKey`, durable notification records and `createNotificationInboxTool`, plus `WebhookSignalProvider`. Webhook provider thread subscriptions are in-memory and do not survive restart; persist and rehydrate subscriptions in the application. The generic provider's `handleWebhook` accepts a body and headers but its type contract does not expose an application signature-verification hook; verify signatures in the HTTP adapter before calling it. The current app has no public intake endpoint, uses a local LibSQL conversation store and per-thread local task SQLite store, and runs a single process. Cross-process routing and durable intake are therefore design requirements for a future endpoint, not capabilities already enabled by this prototype.

References: [Mastra Signals](https://mastra.ai/docs/signals/overview), [Sending signals](https://mastra.ai/docs/signals/sending-signals), [Notifications](https://mastra.ai/docs/signals/notifications), [Running across processes](https://mastra.ai/docs/signals/running-across-processes), [Signal providers](https://mastra.ai/docs/signals/signal-providers), [Notification reference](https://mastra.ai/reference/signals/notifications).
