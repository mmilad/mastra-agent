# Minimal Mastra assistant

One TypeScript assistant that runs locally with Ollama and delegates project
tasks to the locally authenticated Codex agent through ACP. Conversation
threads persist in a local SQLite database, and Studio observability data uses
a separate local DuckDB file. Codex receives this project root as
its ACP workspace and starts in workspace-write mode; the handoff does not grant
access to other folders.

## Setup

Requires Node.js 22.18+ (Node.js 24 LTS recommended).

```sh
npm install
cp .env.example .env
```

The default setup uses local Ollama at `http://127.0.0.1:11434/v1` with
`qwen3.5:9b`, which supports structured tool calls. Pull and start the model,
then copy `.env.example` to `.env`:

```sh
ollama run qwen3.5:9b
cp .env.example .env
```

Configure the connection with `ASSISTANT_API`, `ASSISTANT_API_KEY`, and
`ASSISTANT_MODEL`. The local Ollama server ignores the placeholder API key.
`.env` is ignored by Git. No OpenAI API key is needed for this local setup.

## Run

```sh
npm run chat -- "Say hello in one sentence."
```

Each terminal invocation is still a separate one-shot conversation. Mastra
Studio saves chat threads and messages in `mastra.db` at the project root, so
they remain available after restarting Studio. The assistant loads the latest
20 messages when continuing a thread. For the interactive test interface:

```sh
npm run dev
```

Open http://localhost:4111, select **Assistant**, and send a message.
Stop the server with Ctrl+C.

To test delegation in Studio, ask: “Create `hello.txt` in the project root with
a friendly greeting.” Codex needs to be logged in locally (`codex login status`
should report a ChatGPT login). The assistant returns Codex’s result in the
same conversation. Each task starts a new Codex worker session with the project
root passed as ACP `cwd`, and write access scoped to that workspace.

File operations whose paths are inside the project are allowed within that
workspace grant. The worker may run `pwd`, common read-only inspection commands,
`git status|diff|log|show|rev-parse`, and this project's `npm run check`,
`npm run test:acp`, or `npm run test:policy`. Live provider tests and file
deletion require review. Unknown commands, shell composition, missing paths, and
paths outside the project require review. An out-of-scope ACP permission
request suspends the tool run and shows the operation, project, and that it
expires after five minutes. Resume with that request's token and approve or deny; approval
applies only to that task and exact operation. Worker text cannot approve
requests. Cursor `ask_question` requests also suspend the run; resume with an
answer. Denial, cancellation, and expired approval produce visible outcomes.

## Check

```sh
npm run check
```

## ACP adapter

`src/integrations/acp/client.ts` owns ACP process startup, protocol negotiation,
streamed updates, bounded requests, cancellation, and optional session loading.
Codex and Cursor have separate launch definitions in `providers.ts`. Session
loading is rejected unless the provider advertises it. Delegation policy lives
in `src/policy/workspace.ts`; ACP permissions and Cursor questions suspend the
Mastra tool and resume against validated, task-bound data. Unsupported requests
are cancelled rather than silently accepted.

Run the local protocol tests with:

```sh
npm run test:acp
npm run test:policy
```

To run the same harmless session-and-prompt contract against the installed
Cursor and Codex CLIs (using their existing logins and account quotas):

```sh
RUN_ACP_PROVIDER_TESTS=1 npm run test:acp:providers
```

This checks TypeScript without an API key. To test a real model response after
setting your key:

```sh
npm run chat -- "Reply with exactly: OK"
```

## Files

- `src/mastra/agents/assistant.ts`: assistant instructions and model.
- `src/mastra/tools/delegate-to-codex.ts`: workspace-scoped ACP handoff to Codex.
- `src/policy/workspace.ts`: path, command, and approval scope checks.
- `src/integrations/acp/client.ts`, `src/integrations/acp/providers.ts`: shared ACP client and provider launch settings.
- `tests/acp/`, `tests/policy/`: protocol fixture, opt-in live provider contract checks, and permission-flow tests.
- `src/mastra/index.ts`: registers the assistant with Mastra.
- `mastra.db`: local persisted Studio threads and messages (ignored by Git).
- `mastra-observability.duckdb`: local Studio logs and traces (ignored by Git).
- `src/run.ts`: single-message terminal runner.
- `.env.example`: configuration template, without credentials.
- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`: project setup.

Based on the [Mastra setup guide](https://mastra.ai/docs).

## Planning

This project plans its work with `plantool`. Before changing the plan, run:

```sh
plantool agent onboard
```

Use `plantool` commands or its API to update records; do not edit `.plan` records
by hand. Start the review interface with:

```sh
plantool serve
```

Open http://127.0.0.1:4000 and select **mastra**. Start with **MAST-1**,
**Assistant roadmap and review guide**, and the five open decisions.
The roadmap is a proposal for review; its features are not implemented yet.
`plantool next` shows ready tasks and `plantool context MAST-23` shows the first
compatibility investigation. Run `plantool validate` and `plantool check`
after changing the plan.
