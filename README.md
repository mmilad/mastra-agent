# Minimal Mastra assistant

One TypeScript assistant, with no tools, memory, delegation, MCP, or A2A.
Runs locally; the default model is hosted by OpenAI.

## Setup

Requires Node.js 22.18+ (Node.js 24 LTS recommended).

```sh
npm install
cp .env.example .env
```

The default setup uses local Ollama at `http://127.0.0.1:11434/v1` with the
`llama3` model. Start it with `ollama run llama3`, then copy `.env.example` to
`.env`. Configure the connection with `ASSISTANT_API`, `ASSISTANT_API_KEY`, and
`ASSISTANT_MODEL`. The local Ollama server ignores the placeholder API key.
`.env` is ignored by Git. No OpenAI API key is needed for this local setup.

## Run

```sh
npm run chat -- "Say hello in one sentence."
```

Each terminal invocation is a new conversation. For an interactive test interface:

```sh
npm run dev
```

Open http://localhost:4111, select **Assistant**, and send a message.
Stop the server with Ctrl+C.

## Check

```sh
npm run check
```

This checks TypeScript without an API key. To test a real model response after
setting your key:

```sh
npm run chat -- "Reply with exactly: OK"
```

## Files

- `src/mastra/agents/assistant.ts`: assistant instructions and model.
- `src/mastra/index.ts`: registers the assistant with Mastra.
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
