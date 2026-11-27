export type DelegateWorker = 'codex' | 'cursor' | 'claude';

export type DelegateHandoffBrief = {
  objective: string;
  worker: DelegateWorker;
  acceptanceCriteria: string[];
  constraints: string[];
  handoffSource: 'heuristic';
};

const EDIT_VERBS = /\b(edit|change|update|replace|modify|rewrite|append|fix)\b/i;
const CREATE_VERBS = /\b(create|add|new file|write)\b/i;

function inferWorker(text: string): DelegateWorker {
  if (/\bcursor\b/i.test(text)) return 'cursor';
  if (/\b(claude|anthropic)\b/i.test(text)) return 'claude';
  return 'codex';
}

/** Deterministic brief before assistant calls delegate-task (MAST-82). */
export function buildDelegateHandoffBrief(userText: string): DelegateHandoffBrief {
  const objective = userText.trim();
  const worker = inferWorker(objective);
  const isEdit = EDIT_VERBS.test(objective) && !CREATE_VERBS.test(objective);
  const isCreate = CREATE_VERBS.test(objective);

  const acceptanceCriteria: string[] = [];
  const constraints: string[] = [];

  if (isEdit) {
    acceptanceCriteria.push('Existing target file or symbol is updated as described; no unrelated new files unless required.');
    constraints.push('Prefer editing existing content over creating duplicates.');
  } else if (isCreate) {
    acceptanceCriteria.push('New artifact exists at the path or location implied by the request with the described content.');
  } else {
    acceptanceCriteria.push('Requested code or project change is complete and verifiable.');
  }

  acceptanceCriteria.push('Worker run finishes or waits on approval with a clear status message.');

  return {
    objective,
    worker,
    acceptanceCriteria,
    constraints,
    handoffSource: 'heuristic',
  };
}

export function formatDelegateHandoffForAssistant(brief: DelegateHandoffBrief): string {
  const lines = [
    brief.objective,
    '',
    'Supervisor routing: delegate — call delegate-task exactly once using this handoff brief (do not paraphrase objective away from the user intent):',
    `worker: ${brief.worker}`,
    `objective: ${brief.objective}`,
  ];
  if (brief.constraints.length > 0) {
    lines.push(`constraints: ${JSON.stringify(brief.constraints)}`);
  }
  lines.push(`acceptanceCriteria: ${JSON.stringify(brief.acceptanceCriteria)}`);
  return lines.join('\n');
}