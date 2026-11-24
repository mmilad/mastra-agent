---
schemaVersion: 1
id: "01a2083f-b7dc-77cf-a9ee-ce4dfcc9891c"
title: "One reliable assistant, accountable workers, useful context"
status: "todo"
links: ["01a2083b-a9d7-7058-b040-5ee4a701a9a9"]
createdAt: "2026-11-23T11:52:03.292Z"
updatedAt: "2026-11-24T13:07:01.939Z"
---
Draft for review — 2026-11-23

For Milad: one continuing assistant that understands the current project, remembers useful confirmed information, performs bounded lookups, and delegates implementation to managed coding agents. The assistant must explain what is happening, recover honestly from failures, and return evidence instead of unsupported completion claims. Dot and Grokbot describe the intended experience, not a feature-parity promise.

Confirmed: Mastra + TypeScript exploration, plantool planning, managed agents, context management, tools, skills, Cursor and an OpenAI/ChatGPT-related worker over Agent Client Protocol. The supervisor initially coordinates rather than coding itself.

Proposed first release: single user, local application, one active writer per project, explicit worker capabilities, persistent scoped context, bounded delegation, cancellation and recovery, plantool integration and a small local skill set. Local inference is a separate choice from local application hosting.

All person-owned decisions recorded in plantool are resolved (none open as of 2026-11-24); review them before committing the next milestone scope. A real worker response, memory correctness and failure recovery must be demonstrated. The starter (81ccb91) initially had no delegation or persistent context. Status 2026-11-24: M0 and M1 are implemented on main, and conversation persistence and scoped memory are in place. M2 handoff packets, M3 task recovery and M4 tools are still open.

Success means no silent loss or duplicate execution in recovery tests, no cross-project memory leakage, visible pending approvals, honest supported/unsupported capabilities and evidence attached to task outcomes. Ten pilot tasks are proposed; cost and intervention targets are for the user to set.
