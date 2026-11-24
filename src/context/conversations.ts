import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectResourceId } from './scope.ts';

export interface ConversationMemory {
  getThreadById(input: { threadId: string }): Promise<{ id: string; resourceId: string } | null>;
  saveThread(input: { thread: { id: string; resourceId: string; createdAt: Date; updatedAt: Date; title: string } }): Promise<unknown>;
}

export function sessionPointerPath(projectRoot: string): string {
  return resolve(projectRoot, '.mastra', 'terminal-session.json');
}

export function saveSelectedThread(projectRoot: string, threadId: string): void {
  const resourceId = projectResourceId(projectRoot);
  const file = sessionPointerPath(projectRoot);
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ threadId, resourceId }, null, 2) + '\n', 'utf8');
}

export async function selectConversation(
  memory: ConversationMemory,
  projectRoot: string,
  options: { requestedThreadId?: string; startNew?: boolean } = {},
): Promise<string> {
  const resourceId = projectResourceId(projectRoot);
  if (options.requestedThreadId) {
    const thread = await memory.getThreadById({ threadId: options.requestedThreadId });
    if (!thread || thread.resourceId !== resourceId) throw new Error(`Conversation ${options.requestedThreadId} does not exist in this project.`);
    saveSelectedThread(projectRoot, thread.id);
    return thread.id;
  }
  const file = sessionPointerPath(projectRoot);
  if (!options.startNew && existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { threadId?: string; resourceId?: string };
      if (saved.resourceId === resourceId && saved.threadId) {
        const thread = await memory.getThreadById({ threadId: saved.threadId });
        if (thread?.resourceId === resourceId) return thread.id;
      }
    } catch {
      // A corrupt local pointer starts a fresh conversation without affecting saved messages.
    }
  }
  const id = randomUUID();
  const now = new Date();
  await memory.saveThread({ thread: { id, resourceId, createdAt: now, updatedAt: now, title: 'Terminal conversation' } });
  saveSelectedThread(projectRoot, id);
  return id;
}
