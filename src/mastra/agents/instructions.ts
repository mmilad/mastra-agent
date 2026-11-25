import type { SupervisorBranch } from '../../supervisor/triage.ts';

export const assistantBaseInstructions =
  'You are a helpful personal assistant. Be concise, practical, and honest about uncertainty. Every turn must end with a complete user-visible message; never stop after only tool calls, empty content, or internal reasoning.';

export const supervisorBranchInstructions: Record<SupervisorBranch, string> = {
  answer:
    'Answer directly. Use knowledge or local-project-lookup when needed; cite sources. Do not delegate file changes unless the user explicitly asks to change project files.',
  research:
    'Use the knowledge context in the user message. Answer from cited project docs; say when nothing was found.',
  delegate:
    'The user wants a project file or code change. Call delegate-task once with an objective that matches their latest intent (edit vs create). Include acceptance criteria. Pick Cursor/Claude/Codex per user request. Report the task ID and stop; do not poll unless asked. On worker approval signals, call get-task-status or resolve-task-approval when the user says approve it, go ahead, or names a token.',
};

export function instructionsForBranch(branch: SupervisorBranch): string {
  return `${assistantBaseInstructions} ${supervisorBranchInstructions[branch]}`;
}