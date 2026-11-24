import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ScopedMemoryStore, type MemoryKind, type MemoryScope } from '../../context/memory-store.ts';
import { findWorkspaceRoot, projectResourceId } from '../../context/scope.ts';

const scopeSchema = z.enum(['user', 'project']);
const kindSchema = z.enum(['preference', 'fact', 'summary']);
const inputSchema = z.object({
  operation: z.enum(['recall', 'list', 'remember', 'correct', 'forget', 'export', 'conversations', 'forget_conversation']),
  scope: scopeSchema.optional(),
  kind: kindSchema.optional(),
  key: z.string().max(120).optional(),
  value: z.string().max(4000).optional(),
  recordId: z.string().uuid().optional(),
  derivedFrom: z.array(z.string().uuid()).max(20).optional(),
  query: z.string().max(200).optional(),
  conversationId: z.string().min(1).max(200).optional(),
});
const stores = new Map<string, ScopedMemoryStore>();

function getStore(root: string): ScopedMemoryStore {
  let store = stores.get(root);
  if (!store) {
    store = new ScopedMemoryStore({ projectRoot: root });
    stores.set(root, store);
  }
  return store;
}

export const manageMemory = createTool({
  id: 'manage-memory',
  description:
    'Recall, inspect, correct, forget, and export local context. User preferences are global; project facts and conversations are isolated to the current project. Only remember a fact or preference when the user explicitly asks you to remember it. Never store credentials. Ask for confirmation before forgetting a conversation.',
  inputSchema,
  outputSchema: z.object({ ok: z.boolean(), message: z.string(), data: z.string().optional() }),
  requireApproval: input => input.operation === 'forget_conversation',
  execute: async (input, context) => {
    const root = findWorkspaceRoot();
    const store = getStore(root);
    try {
      if (input.operation === 'recall' || input.operation === 'list') {
        const records = await store.list({
          scope: input.scope as MemoryScope | undefined,
          kind: input.kind as MemoryKind | undefined,
          query: input.query,
          includeHistory: input.operation === 'list',
        });
        return { ok: true, message: `${records.length} ${input.operation === 'list' ? 'memory record(s)' : 'active context item(s)'}.`, data: JSON.stringify(records) };
      }
      if (input.operation === 'remember' || input.operation === 'correct') {
        if (!input.scope || !input.kind || !input.key || !input.value) {
          return { ok: false, message: 'Remembering or correcting requires scope, kind, key, and value.' };
        }
        const record = await store.remember({
          scope: input.scope,
          kind: input.kind,
          key: input.key,
          value: input.value,
          source: 'user-confirmed',
          sourceId: context?.agent?.threadId ?? 'explicit-user-request',
          derivedFrom: input.derivedFrom,
          correct: input.operation === 'correct',
        });
        return { ok: true, message: `${input.operation === 'correct' ? 'Corrected' : 'Saved'} ${record.scope} ${record.kind} “${record.key}” as revision ${record.revision}.`, data: JSON.stringify(record) };
      }
      if (input.operation === 'forget') {
        if (!input.scope || (!input.recordId && !input.key)) return { ok: false, message: 'Forgetting a memory record requires its scope and either recordId or key.' };
        const result = await store.forget({ scope: input.scope, recordId: input.recordId, key: input.key });
        return { ok: true, message: `Forgot ${result.forgotten} record(s), including superseded revisions and derived records.` };
      }
      if (input.operation === 'export') {
        return { ok: true, message: 'Export contains only allowlisted memory fields; credentials and raw conversation messages are excluded.', data: JSON.stringify(await store.export(), null, 2) };
      }
      const memoryStore = await context?.mastra?.getStorage()?.getStore('memory');
      if (!memoryStore) return { ok: false, message: 'Conversation storage is unavailable in this runtime.' };
      const resourceId = projectResourceId(root);
      if (input.operation === 'conversations') {
        const result = await memoryStore.listThreads({ filter: { resourceId }, page: 0, perPage: 50 });
        return { ok: true, message: `${result.threads.length} conversation(s) in this project.`, data: JSON.stringify(result.threads.map(thread => ({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt }))) };
      }
      if (!input.conversationId) return { ok: false, message: 'A conversationId is required. Ask the user to identify the conversation before forgetting it.' };
      const thread = await memoryStore.getThreadById({ threadId: input.conversationId, resourceId });
      if (!thread) return { ok: false, message: 'That conversation does not exist in the current project scope.' };
      await memoryStore.deleteThread({ threadId: thread.id });
      const forgottenProject = await store.forgetSource({ scope: 'project', sourceId: thread.id });
      const forgottenUser = await store.forgetSource({ scope: 'user', sourceId: thread.id });
      const forgotten = forgottenProject + forgottenUser;
      return { ok: true, message: `Forgot conversation “${thread.title ?? thread.id}” and its stored messages${forgotten ? ` plus ${forgotten} derived memory record(s)` : ''}.` };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
});
