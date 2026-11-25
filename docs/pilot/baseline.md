# Pilot baseline (MAST-53)

Captured 2026-11-25 for the local-first MVP assistant.

## Fixed configuration (do not change until pilot review)

| Setting | Value |
| --- | --- |
| Model | `qwen3.5:9b` (`ASSISTANT_MODEL`) |
| API | Local Ollama `http://127.0.0.1:11434/v1` |
| Context window | 32768 tokens (Ollama model config) |
| GPU | NVIDIA RTX 4080 SUPER (user workstation) |
| Message history budget | 6000 tokens, trim 1500 (`assistant` memory) |
| Worker timeout | `TASK_TIMEOUT_MS` default 15m |

## Observation log

Add rows during normal use before changing any model or context setting.

| Date | Scenario | Quality (1–5) | Speed (1–5) | Notes |
| --- | --- | --- | --- | --- |
| 2026-11-25 | Signals + delegation MVP | — | — | 32k context appears usable in dev; formal multi-chat sampling still open |

## Related checks

- `npm run test:acceptance` — deterministic vertical slice
- `RUN_ACP_PROVIDER_TESTS=1 npm run test:acp:providers` — opt-in live worker smoke