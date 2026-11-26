# Supervisor triage evaluation (MAST-81)

Golden cases live in `tests/supervisor/triage-golden.jsonl`. Each line is JSON:

- `text` — user message
- `branch` — expected `answer` | `research` | `delegate` (full heuristic `triageUserPrompt`)
- `expectFastPath` — when `true`, `triageHighConfidenceBranch` must match; when `false`, fast path must abstain (LLM or ingest needed)
- optional `kind` — checks `ingestUserPromptHeuristic` primary kind

## CI (heuristic, no Ollama)

```sh
npm run test:supervisor
```

Runs unit tests plus the golden suite. Safe for every push; no network or local model required.

## Optional live LLM triage (nightly / manual)

Compare heuristic vs LLM on the same jsonl (not automated in-repo yet):

```sh
# force LLM path; requires Ollama + mastra env
set SUPERVISOR_TRIAGE_LLM_ALWAYS=1
set SUPERVISOR_TRIAGE_HEURISTIC_ONLY=
npm run supervisor:smoke
```

Record mismatches in Plantool or extend `triage-golden.jsonl` when product agrees on expected LLM behavior.