import type { MemoryRecord } from './memory-store.ts';
import { projectScopeId } from './scope.ts';

export type HandoffBrief = {
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  contextReferences: string[];
};

export type HandoffPackage = {
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  facts: Array<Pick<MemoryRecord, 'id' | 'revision' | 'key' | 'value'>>;
  omittedFactCount: number;
  error?: string;
};

export function buildHandoffPackage(
  brief: HandoffBrief,
  projectRoot: string,
  memories: MemoryRecord[],
  budget = 6000,
): HandoffPackage {
  const projectId = projectScopeId(projectRoot);
  const facts = memories
    .filter(record => record.scope === 'project' && record.projectId === projectId && record.status === 'active' && record.kind === 'fact')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, revision, key, value }) => ({ id, revision, key, value }));
  const base: HandoffPackage = {
    objective: brief.objective,
    constraints: [...brief.constraints],
    acceptanceCriteria: [...brief.acceptanceCriteria],
    facts: [],
    omittedFactCount: facts.length,
  };
  // Required brief text is preserved even if it alone exceeds the configured budget.
  const baseLength = serializedLength(base);
  for (const fact of facts) {
    const candidate = { ...base, facts: [...base.facts, fact], omittedFactCount: facts.length - base.facts.length - 1 };
    if (serializedLength(candidate) <= Math.max(budget, baseLength)) base.facts.push(fact);
  }
  base.omittedFactCount = facts.length - base.facts.length;
  return base;
}

export function handoffPackageLength(handoff: HandoffPackage): number {
  return serializedLength(handoff);
}

function serializedLength(handoff: HandoffPackage): number {
  return JSON.stringify(handoff).length;
}
