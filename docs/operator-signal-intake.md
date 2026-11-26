# Signal intake operator guide (MAST-73)

Database: `signal-intake.db` next to `mastra.db` (see `assistantDatabasePath()`).

## Commands

```sh
npm run intake -- list pending
npm run intake -- list dispatched
npm run intake -- list failed
npm run intake -- list unrouted
```

Dispatched rows may show routing metadata parsed from `routing_note` (e.g. `branch=research kind=project_research compound`).

```sh
npm run intake -- retry <eventId>
npm run intake -- resolve <eventId> <conversationId>
npm run intake -- reconcile
```

## Long-running supervisor

```sh
npm run supervisor
```

Runs Mastra bootstrap and reconciles **accepted** intake rows every `SUPERVISOR_RECONCILE_MS` (default 60s). Use with `mastra dev` or alone for intake recovery after crashes.

## HTTP ingress

### Thin chat API (custom WebUI)

```sh
curl -s -X POST http://localhost:4111/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"text":"Say hello","threadId":"<uuid>","sync":true}'
```

Optional `Authorization: Bearer $SIGNAL_INTAKE_TOKEN` when the token is set (same as envelope intake).

### Full envelope

Set `SIGNAL_INTAKE_TOKEN`, restart `mastra dev`, then:

```sh
curl -s -X POST http://localhost:4111/signal-intake \
  -H "Authorization: Bearer $SIGNAL_INTAKE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-conversation-id: <uuid>" \
  -d '{"schemaVersion":1,"category":"user_prompt",...}'
```

See `docs/mastra-signals.md` for the full envelope.

## Thread debug

```sh
npm run intake -- thread <threadId|studio-url>
```