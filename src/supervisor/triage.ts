export const supervisorBranches = ['answer', 'research', 'delegate'] as const;
export type SupervisorBranch = (typeof supervisorBranches)[number];

const delegatePattern =
  /\b(create|edit|delete|fix|implement|refactor|add|remove|write|patch|change)\b/;
const delegateTargetPattern =
  /\b(file|files|code|function|class|test|tests|component|module|repo|bug)\b|\.(ts|tsx|js|jsx|py|md|json|yaml|yml)\b/i;
const researchPattern =
  /\b(what is|how does|explain|documented|where is|lookup|search|find in|according to|in the docs)\b/i;

/** Regex fallback when LLM triage fails or `SUPERVISOR_TRIAGE_HEURISTIC_ONLY` is set. */
export function triageUserPrompt(text: string): SupervisorBranch {
  const trimmed = text.trim();
  if (!trimmed) return 'answer';
  const lower = trimmed.toLowerCase();
  if (delegatePattern.test(lower) && delegateTargetPattern.test(trimmed)) return 'delegate';
  if (/\b(delegate|start worker|run worker)\b/i.test(trimmed)) return 'delegate';
  if (researchPattern.test(trimmed)) return 'research';
  return 'answer';
}