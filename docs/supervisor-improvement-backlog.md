# Supervisor routing improvement backlog

Parent: **MAST-59** (M6). Follow-on to **MAST-64–66** (v1 shipped). Tickets created 2026-11-25 from Studio workflow pilot + architecture review.

Industry patterns cited in tickets: [rule-first routing](https://www.compilenrun.com/docs/ai/agents/agents-planning-and-reasoning/agents-routing/), [semantic / abstain routing](https://proagenticworkflows.ai/harnessing-semantic-routing-for-llm-agents-in-ai-agentic-workflows), [handoff orchestration](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns), [dynamic bypass](https://arxiv.org/pdf/2412.05449v1.pdf).

| ID | Title | Tier |
| --- | --- | --- |
| MAST-78 | Supervisor v2 epic — routing quality, latency, ops | Epic |
| MAST-79 | Heuristic-first triage (skip LLM when unambiguous) | 1 |
| MAST-80 | Persist branch / triageSource / rationale on intake ledger | 1 |
| MAST-81 | Triage golden suite (labeled messages + CI) | 2 |
| MAST-82 | `delegate-handoff` workflow | 1 |
| **MAST-83** | **Decision (human):** Assistant always synthesizes — internal agents never speak to user | **Decided → MAST-85** |
| MAST-84–86 | Options for MAST-83 | Options |
| MAST-87 | Research branch: optimize pipeline under MAST-85 (latency, prompts, tools) | 1 |
| **MAST-94** | **Decision:** Phased ingest + decompose → map to branches | **Decided → MAST-96** |
| MAST-98 | Define prompt-kind primitives and ingest contract | Planning |
| MAST-88 | Context-aware triage (recent thread context) | 2 |
| MAST-89 | Branch-aware assistant tool profiles | 2 |
| MAST-90 | Dedicated triage model + structured branch output | 2 |
| MAST-91 | Align Studio `supervisorBranch` metadata with workflow triage | 2 |
| MAST-92 | Wrong-branch recovery UX (discussion + optional reroute) | 3 |
| MAST-93 | Register supervisor-triage agent on Mastra (optional DX) | 3 |

Implementation order (updated): **98 ✓ · 79 ✓ · 81 ✓ · 80 (partial) · 82 · 87 · 99 · 88–93**.

**Lead cadence:** push `main` when supervisor tests pass and commits are self-contained; one MAST ticket per commit when practical; no push on WIP unless you ask for a backup branch.

| ID | Title | Status |
| --- | --- | --- |
| MAST-98 | Prompt-kind primitives + ingest contract | **Done** (doc + Phase A heuristic) |
| MAST-99 | Phase B: LLM ingest + confidence-gated decompose | Planned |
| MAST-100 | Phase C: sequential ledger fan-out for compound | Planned |

Contract reference: `docs/supervisor-workflow-contract.md`. Architecture: `docs/architecture/decisions.md`.