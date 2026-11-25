import type { Agent } from '@mastra/core/agent';
import { findWorkspaceRoot, projectResourceId } from './scope.ts';

/** Mastra Studio often uses the agent id as resourceId; CLI uses projectResourceId. */
export async function resolveThreadResourceId(
  agent: Agent,
  threadId: string,
  fallback = projectResourceId(findWorkspaceRoot()),
): Promise<string> {
  if (typeof agent.getMemory !== 'function') return fallback;
  try {
    const memory = await agent.getMemory();
    if (!memory) return fallback;
    const thread = await memory.getThreadById({ threadId });
    if (thread?.resourceId) return thread.resourceId;
  } catch {
    /* use fallback */
  }
  return fallback;
}

export type MemoryStoreLike = {
  getThreadById?: (opts: { threadId: string; resourceId: string }) => Promise<{ resourceId?: string } | null>;
};

export type MastraLike = {
  getAgent?: (id: string) => Agent | undefined;
  getStorage?: () => { getStore?: (name: string) => Promise<MemoryStoreLike | undefined> } | undefined;
};

/** Tool runtimes pass a lightweight agent handle; use Mastra for the real assistant + memory store. */
export async function resolveThreadResourceIdFromContext(
  input: { agent?: { getMemory?: Agent['getMemory']; threadId?: string }; mastra?: MastraLike },
  threadId: string,
  fallback = projectResourceId(findWorkspaceRoot()),
): Promise<string> {
  const assistant = input.mastra?.getAgent?.('assistant');
  const agent =
    assistant && typeof assistant.getMemory === 'function'
      ? assistant
      : input.agent && typeof input.agent.getMemory === 'function'
        ? (input.agent as Agent)
        : undefined;
  if (agent) return resolveThreadResourceId(agent, threadId, fallback);
  const store = await input.mastra?.getStorage?.()?.getStore?.('memory');
  if (store?.getThreadById) {
    for (const resourceId of new Set([fallback, 'assistant'])) {
      try {
        const thread = await store.getThreadById({ threadId, resourceId });
        if (thread?.resourceId) return thread.resourceId;
      } catch {
        /* try next candidate */
      }
    }
  }
  return fallback;
}