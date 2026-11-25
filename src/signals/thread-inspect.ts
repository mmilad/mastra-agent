import { DatabaseSync } from 'node:sqlite';
import { assistantDatabasePath } from '../context/scope.ts';

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

export function parseThreadIdFromStudioUrl(input: string): string {
  const trimmed = input.trim();
  if (UUID_RE.test(trimmed) && trimmed.length <= 40) return trimmed;
  const match = trimmed.match(UUID_RE);
  return match?.[0] ?? trimmed;
}

function textPreview(content: string, max = 240): string {
  try {
    const parsed = JSON.parse(content) as { parts?: Array<{ type?: string; text?: string }>; text?: string };
    if (typeof parsed.text === 'string') return parsed.text.slice(0, max);
    if (Array.isArray(parsed.parts)) {
      return parsed.parts
        .map((part) => (part?.type === 'text' && part.text ? part.text : ''))
        .filter(Boolean)
        .join(' ')
        .slice(0, max);
    }
  } catch {
  }
  return content.slice(0, max);
}

export type ThreadInspectResult = {
  found: boolean;
  threadId: string;
  thread?: { resourceId: string; title: string; createdAt: string; updatedAt: string };
  messages?: Array<{ role: string; createdAt: string; preview: string }>;
  notifications?: Array<{ kind: string; summary: string; createdAt: string; status: string }>;
  error?: string;
};

export function inspectStudioThread(threadIdOrUrl: string, limit = 30): ThreadInspectResult {
  const threadId = parseThreadIdFromStudioUrl(threadIdOrUrl);
  try {
    const db = new DatabaseSync(assistantDatabasePath());
    const thread = db
      .prepare('SELECT id, resourceId, title, createdAt, updatedAt FROM mastra_threads WHERE id = ?')
      .get(threadId) as { id: string; resourceId: string; title: string; createdAt: string; updatedAt: string } | undefined;
    if (!thread) return { found: false, threadId };
    const messages = db
      .prepare(
        'SELECT role, content, createdAt FROM mastra_messages WHERE thread_id = ? ORDER BY createdAt DESC LIMIT ?',
      )
      .all(threadId, limit) as Array<{ role: string; content: string; createdAt: string }>;
    const notifications = db
      .prepare(
        'SELECT kind, summary, status, createdAt FROM mastra_notifications WHERE threadId = ? ORDER BY createdAt DESC LIMIT ?',
      )
      .all(threadId, Math.min(limit, 15)) as Array<{ kind: string; summary: string; status: string; createdAt: string }>;
    return {
      found: true,
      threadId,
      thread: {
        resourceId: thread.resourceId,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      messages: messages
        .reverse()
        .map((row) => ({ role: row.role, createdAt: row.createdAt, preview: textPreview(row.content) })),
      notifications: notifications.map((row) => ({
        kind: row.kind,
        summary: row.summary,
        status: row.status,
        createdAt: row.createdAt,
      })),
    };
  } catch (error) {
    return {
      found: false,
      threadId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatThreadInspect(result: ThreadInspectResult): string {
  if (!result.found) {
    return result.error
      ? `Thread ${result.threadId} not found (${result.error}).`
      : `Thread ${result.threadId} not found in ${assistantDatabasePath()}.`;
  }
  const lines = [
    `Thread ${result.threadId}`,
    `  resource: ${result.thread?.resourceId}`,
    `  title: ${result.thread?.title}`,
    `  updated: ${result.thread?.updatedAt}`,
    '',
    'Messages:',
  ];
  for (const message of result.messages ?? []) {
    lines.push(`  [${message.createdAt}] ${message.role}: ${message.preview}`);
  }
  if (result.notifications?.length) {
    lines.push('', 'Notifications:');
    for (const note of result.notifications) {
      lines.push(`  [${note.createdAt}] ${note.kind}/${note.status}: ${note.summary}`);
    }
  }
  return lines.join('\n');
}