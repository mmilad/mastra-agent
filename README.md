# Minimal Mastra assistant

One TypeScript assistant that runs locally with Ollama and delegates project
tasks to the locally authenticated Codex agent through ACP. Conversation
threads persist in a local SQLite database, and Studio observability data uses
a separate local DuckDB file. Codex receives this project root as
its ACP workspace and starts in workspace-write mode; the handoff does not grant
access to other folders.

## Setup

Requires Node.js 22.18.x or Node.js 24.11.0+ (Node.js 24 LTS recommended).

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

For Mastra Studio, configure Ollama with at least a 16K context window. Ollama
defaults to 4,096 tokens; the model's larger native context is not allocated
automatically. Check the active allocation with `ollama ps`. On Windows, change
the context length in Ollama's Settings, then quit and relaunch Ollama so the
server and model use the new value. The assistant itself keeps up to 6,000 input
tokens and allows 2,048 output tokens per model step.

Configure the connection with `ASSISTANT_API`, `ASSISTANT_API_KEY`, and
`ASSISTANT_MODEL`. The local Ollama server ignores the placeholder API key.
`.env` is ignored by Git. No OpenAI API key is needed for this local setup.

## Run

Start an interactive terminal conversation. It resumes the selected conversation
after restart and scopes conversation history to this project. Type `:exit` to
close it; any tasks still active in that terminal process are cancelled:

```sh
npm run chat
```

For a one-shot response:

```sh
npm run chat -- "Say hello in one sentence."
```

Use `ASSISTANT_PROJECT_ROOT=/path/to/project` to select another local workspace.
The assistant keeps one local SQLite database for user preferences and separates
project facts and conversation threads by the selected workspace root. Use
`npm run chat -- --new` to start a separate conversation, `npm run chat -- --list`
to list this project's conversations, and `npm run chat -- --thread <id>` to
select a conversation. In interactive mode, `:new`, `:threads`, and `:use <id>`
do the same. The selected thread pointer is local under `.mastra/`; its messages
remain in the SQLite database. Project scope is derived from the selected workspace root,
so conversations and project facts from another workspace are not retrieved.

Mastra Studio saves chat threads and messages in `mastra.db` at the project
root, so they remain available after restarting Studio. The assistant loads at
most the latest 20 messages and trims older history when its configured
6,000-token context budget is exceeded. Studio and direct calls allow up to
2,048 output tokens per model step. Thread working memory keeps a bounded
snapshot of the objective, constraints, unresolved work, and decisions across
turns. For the interactive test interface:

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

The `manage-memory` tool supports recall, inspection with history, saving an
explicitly requested preference or project fact, correcting it, forgetting it,
and exporting allowlisted memory fields. User preferences have a global scope;
project facts use the current workspace scope. Conversation deletion is limited
to the current project and requires tool approval. Exports contain memory records
only, not raw chat transcripts or credentials. Credentials are rejected when
they match common API key, bearer token, or provider token formats.

Agent Skills use the standard folder format under `.agents/skills/<name>/SKILL.md`.
The assistant first discovers each skill's metadata, then loads a matching body
with its source, optional `metadata.version`, and the reason it was selected. To
choose another project-relative skill folder or disable skills, create
`.mastra/skills.json`, for example `{"directory":"skills","disabled":["release-notes"]}`.
Skills are untrusted guidance: declared `metadata.conflicts` prevent conflicting
skills from loading together, and bundled scripts are never executed by the
loader. Loaded-skill conflict state is stored per project and thread in
`mastra.db`, so conflicts are still enforced when a thread resumes after a
process restart. Skill text cannot grant tools or permissions.

The assistant returns a task ID as soon as it starts work. Ask for status or
cancel using that ID. If an approval is needed, reply exactly `approve <token>`
or `deny <token>`; for a worker question, reply `answer <token>: <your answer>`.
Task records and approvals are persisted in `assistant-tasks.db`. Active tasks
are marked interrupted after a process restart and are not automatically
replayed. The per-project queue, timeout, cancellation outcome, and changed-file
evidence are recorded with each task; a reported success remains unverified
until required evidence exists.

## Check

```sh
npm run check
```

`npm run check` runs only the TypeScript compiler (`tsc --noEmit`); it does not
run tests. The available test scripts are:

```sh
npm run test:policy
npm run test:context
npm run test:acp
npm run test:acp:providers
npm run test:plantool
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
- `src/context/`: project identity, durable conversation selection, and scoped memory records.
- `src/mastra/tools/memory.ts`: inspect, correct, forget, and export operations for context.
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
**Assistant roadmap and review guide**, and the recorded decisions (none are open as of 2026-11-24).
M0 and M1 are implemented; conversation persistence and scoped memory are in place. The roadmap is a proposal for review, and M2 to M5 remain open.
`plantool next` shows ready tasks and `plantool context MAST-23` shows the first
compatibility investigation. Run `plantool validate` and `plantool check`
after changing the plan.

Run `plantool` commands only in this main checkout, not in git worktrees. plantool
registers every folder where a command runs, and a worktree gets its own `.plan`
copy, so plan edits there can end up on a feature branch. Use worktrees for code
changes only. After removing a worktree, run `plantool projects prune`.
