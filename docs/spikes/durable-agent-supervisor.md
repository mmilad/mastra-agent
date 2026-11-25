# Durable agent spike for supervisor (MAST-68)

Status: **no-go for v1** (2026-11-25).

## Question

Should multi-step supervisor runs (research → summarize → delegate) use Mastra **durable agent / workflow suspend** instead of chained `generate()` + `sendMessage()`?

## Findings

- Local stack is **single-process**, **Ollama**, and **LibSQL** memory. Supervisor v1 already splits work across a **Mastra workflow** (`supervisor-routing`) and bounded tool calls.
- Durable agent streams add operational cost (lease recovery, suspended state inspection) without fixing the current pilot bottleneck (worker ACP + intake reconcile).
- `maxSteps` + continuation helper covers “tool then answer” gaps for the interactive CLI.

## Decision

**Defer durable agent** until:

1. MAST-74 DOT loop is stable in CI, and
2. A real scenario exceeds workflow + `maxSteps` (measured in Studio or supervisor logs).

If revived, first vertical slice: research branch suspends after `knowledge-answer`, resumes on worker notification— not a full durable agent rewrite.