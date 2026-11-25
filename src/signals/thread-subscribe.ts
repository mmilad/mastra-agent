import type { Agent } from '@mastra/core/agent';

type ThreadRef = { resourceId: string; threadId: string };

const active = new Map<string, Promise<void>>();

function key(thread: ThreadRef): string {
  return `${thread.resourceId}:${thread.threadId}`;
}

/** One server-side subscription per thread so idle threads can receive notifications. */
export async function ensureThreadSubscribed(agent: Agent, thread: ThreadRef): Promise<void> {
  const id = key(thread);
  let pending = active.get(id);
  if (!pending) {
    pending = (async () => {
      try {
        await agent.subscribeToThread(thread);
      } catch (error) {
        active.delete(id);
        throw error;
      }
    })();
    active.set(id, pending);
  }
  await pending;
}