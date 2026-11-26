import type { SupervisorBranch } from './triage.ts';

/** User-intent labels (MAST-98). Execution still uses supervisor branches. */
export const promptKinds = [
  'social',
  'general_qa',
  'project_research',
  'project_task',
  'planning',
  'ops',
  'compound',
] as const;

export type PromptKind = (typeof promptKinds)[number];

export type SubIntent = {
  text: string;
  kinds: PromptKind[];
  suggestedBranch?: SupervisorBranch;
};

export type PromptIngestResult = {
  kinds: PromptKind[];
  primaryKind: PromptKind;
  compound: boolean;
  subIntents: SubIntent[];
  ingestSource: 'heuristic' | 'llm';
};

const socialPattern = /^(hi|hello|hey|thanks|thank you|thx|ok|okay|got it|cool)[\s!.?]*$/i;
const planningPattern = /\b(plantool|roadmap|ticket|milestone|backlog|create task in plan)\b/i;
const opsPattern = /\b(approve|deny|cancel task|task status|get-task|approve it|go ahead)\b/i;

export function suggestedBranchForKind(kind: PromptKind): SupervisorBranch {
  switch (kind) {
    case 'project_research':
      return 'research';
    case 'project_task':
      return 'delegate';
    default:
      return 'answer';
  }
}

export function isPromptKind(value: unknown): value is PromptKind {
  return typeof value === 'string' && (promptKinds as readonly string[]).includes(value);
}

export { socialPattern, planningPattern, opsPattern };