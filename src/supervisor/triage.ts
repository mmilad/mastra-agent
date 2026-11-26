export const supervisorBranches = ['answer', 'research', 'delegate'] as const;
export type SupervisorBranch = (typeof supervisorBranches)[number];

const delegatePattern =
  /\b(create|edit|delete|fix|implement|refactor|add|remove|write|patch|change)\b/;
const delegateTargetPattern =
  /\b(file|files|code|function|class|test|tests|component|module|repo|bug)\b|\.(ts|tsx|js|jsx|py|md|txt|json|yaml|yml)\b/i;
const researchPattern =
  /\b(what is|how does|explain|documented|where is|lookup|search|find in|according to|in the docs)\b/i;

export function matchesDelegateIntent(text: string): boolean {
  const lower = text.toLowerCase();
  if (delegatePattern.test(lower) && delegateTargetPattern.test(text)) return true;
  return /\b(delegate|start worker|run worker)\b/i.test(text);
}

export function matchesResearchIntent(text: string): boolean {
  return researchPattern.test(text);
}

/**
 * When delegate and research cues do not conflict, branch without an LLM call (MAST-79).
 * Returns `undefined` when both match — caller should use LLM triage.
 */
export function triageHighConfidenceBranch(text: string): SupervisorBranch | undefined {
  const trimmed = text.trim();
  if (!trimmed) return 'answer';
  const delegate = matchesDelegateIntent(trimmed);
  const research = matchesResearchIntent(trimmed);
  if (delegate && research) return undefined;
  if (delegate) return 'delegate';
  if (research) return 'research';
  return 'answer';
}

/** Regex fallback when LLM triage fails or `SUPERVISOR_TRIAGE_HEURISTIC_ONLY` is set. */
export function triageUserPrompt(text: string): SupervisorBranch {
  const trimmed = text.trim();
  if (!trimmed) return 'answer';
  const lower = trimmed.toLowerCase();
  if (matchesDelegateIntent(trimmed)) return 'delegate';
  if (matchesResearchIntent(trimmed)) return 'research';
  return 'answer';
}