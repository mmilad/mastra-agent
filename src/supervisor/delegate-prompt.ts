const EDIT_VERBS = /\b(edit|change|update|replace|modify|rewrite|append|fix)\b/i;
const CREATE_VERBS = /\b(create|add|new file|write)\b/i;

/** Sharpen delegate branch prompts so objectives reflect edit vs create. */
export function buildDelegateSupervisorPrompt(userText: string): string {
  const trimmed = userText.trim();
  const lines = [
    trimmed,
    '',
    'Supervisor routing: delegate — you must call delegate-task exactly once in this turn.',
  ];
  if (EDIT_VERBS.test(trimmed) && !CREATE_VERBS.test(trimmed)) {
    lines.push(
      'The user asked to change existing content, not create a unrelated file. State an edit/update objective with a clear acceptance criterion.',
    );
  } else if (CREATE_VERBS.test(trimmed)) {
    lines.push('State a create objective with path and content criteria.');
  }
  if (/\bcursor\b/i.test(trimmed)) lines.push('Use worker: cursor.');
  else if (/\b(claude|anthropic)\b/i.test(trimmed)) lines.push('Use worker: claude.');
  return lines.join('\n');
}