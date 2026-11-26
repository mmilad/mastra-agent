import { matchesDelegateIntent, matchesResearchIntent, triageUserPrompt } from './triage.ts';
import {
  type PromptIngestResult,
  type PromptKind,
  type SubIntent,
  opsPattern,
  planningPattern,
  socialPattern,
  suggestedBranchForKind,
} from './prompt-kinds.ts';

const compoundSplitPattern = /\s+and\s+|\s*;\s+/i;
const socialLoosePattern = /\b(thanks|thank you|thx|hello|hi|hey)\b/i;

function collectKinds(text: string): PromptKind[] {
  const trimmed = text.trim();
  const kinds = new Set<PromptKind>();
  if (!trimmed) {
    kinds.add('general_qa');
    return [...kinds];
  }
  if (socialPattern.test(trimmed) || socialLoosePattern.test(trimmed)) kinds.add('social');
  if (matchesResearchIntent(trimmed)) kinds.add('project_research');
  if (matchesDelegateIntent(trimmed)) kinds.add('project_task');
  if (planningPattern.test(trimmed)) kinds.add('planning');
  if (opsPattern.test(trimmed)) kinds.add('ops');
  if (kinds.size === 0) kinds.add('general_qa');
  return [...kinds];
}

function isExecutionCompound(kinds: PromptKind[]): boolean {
  return kinds.includes('project_research') && kinds.includes('project_task');
}

function primaryKind(kinds: PromptKind[]): PromptKind {
  const order: PromptKind[] = ['compound', 'project_task', 'project_research', 'planning', 'ops', 'social', 'general_qa'];
  for (const kind of order) {
    if (kinds.includes(kind)) return kind;
  }
  return 'general_qa';
}

function branchForText(text: string): SubIntent['suggestedBranch'] {
  return triageUserPrompt(text);
}

function buildSubIntent(text: string): SubIntent {
  const kinds = collectKinds(text);
  const primary = primaryKind(kinds);
  return {
    text: text.trim(),
    kinds,
    suggestedBranch: suggestedBranchForKind(primary),
  };
}

function trySplitCompound(text: string): string[] | undefined {
  if (!compoundSplitPattern.test(text)) return undefined;
  const parts = text.split(compoundSplitPattern).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return undefined;
  const branches = new Set(parts.map((p) => branchForText(p)));
  return branches.size > 1 ? parts : undefined;
}

/** Phase A (MAST-96): heuristic kinds + optional sub-intent split; no ledger fan-out. */
export function ingestUserPromptHeuristic(text: string): PromptIngestResult {
  const trimmed = text.trim();
  let kinds = collectKinds(trimmed);
  const executionCompound = isExecutionCompound(kinds);
  if (executionCompound) kinds = [...new Set([...kinds, 'compound' as PromptKind])];

  let subIntents: SubIntent[];
  const splitParts = executionCompound ? trySplitCompound(trimmed) : undefined;
  if (splitParts) {
    subIntents = splitParts.map((part) => buildSubIntent(part));
  } else {
    subIntents = [buildSubIntent(trimmed || '(empty)')];
  }

  const compound = executionCompound || subIntents.length > 1;

  return {
    kinds,
    primaryKind: compound && executionCompound ? 'compound' : primaryKind(kinds),
    compound,
    subIntents,
    ingestSource: 'heuristic',
  };
}

export async function ingestUserPrompt(text: string): Promise<PromptIngestResult> {
  return ingestUserPromptHeuristic(text);
}