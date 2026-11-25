import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findProjectRoot } from './delegate-to-codex.ts';
import { taskRegistry } from './task-registry.ts';
import { buildHandoffPackage } from '../../context/handoff.ts';
import { projectResourceId } from '../../context/scope.ts';
import { resolveThreadResourceIdFromContext, type MastraLike } from '../../context/thread-resource.ts';
import { ScopedMemoryStore } from '../../context/memory-store.ts';

const handoffStores = new Map<string, ScopedMemoryStore>();
function getHandoffStore(root: string): ScopedMemoryStore {
  let store = handoffStores.get(root);
  if (!store) {
    store = new ScopedMemoryStore({ projectRoot: root });
    handoffStores.set(root, store);
  }
  return store;
}

const taskStateSchema = z.enum([
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'cancelling',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);

const pendingApprovalSchema = z.object({
  approvalToken: z.string(),
  kind: z.enum(['permission', 'question']),
  operation: z.string().optional(),
  summary: z.string(),
  expiresAt: z.number(),
});

/** Models often send one string; coerce to a bounded string array for tool validation. */
function coerceStringList(maxItems: number) {
  return z.preprocess((value) => {
    if (value == null) return [];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* split below */
        }
      }
      return trimmed.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean);
    }
    return Array.isArray(value) ? value : [];
  }, z.array(z.string().max(500)).max(maxItems).transform((items) => items.map((item) => String(item).trim()).filter(Boolean)));
}

const taskSnapshotSchema = z.object({
  taskId: z.string(),
  objective: z.string(),
  projectRoot: z.string(),
  worker: z.enum(['codex', 'cursor', 'claude']),
  status: taskStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.array(z.string()),
  approval: pendingApprovalSchema.optional(),
  workerOutput: z.string().optional(),
  workerStopReason: z.string().optional(),
  error: z.string().optional(),
  acceptanceVerified: z.literal(false),
  handoff: z.object({
    objective: z.string(), constraints: z.array(z.string()), acceptanceCriteria: z.array(z.string()),
    facts: z.array(z.object({ id: z.string(), revision: z.number(), key: z.string(), value: z.string() })),
    omittedFactCount: z.number(), error: z.string().optional(),
  }).optional(),
});

export const delegateTaskInputSchema = z.object({
  objective: z.string().min(1).max(4000),
  worker: z.enum(['codex', 'cursor', 'claude']).default('codex'),
  constraints: coerceStringList(12).default([]),
  acceptanceCriteria: coerceStringList(12).default([]),
  contextReferences: coerceStringList(12).default([]),
});

export const delegateTask = createTool({
  id: 'delegate-task',
  description:
    'Start one bounded task with the selected ACP worker in this project and return its stable task ID immediately. Choose Codex by default, Cursor when the user requests Cursor or its project context is useful, or Claude when the user requests Claude/Anthropic. Use only for a new task. For status, approval, or cancellation requests, use the matching task tool instead of starting another worker. Pass constraints, acceptanceCriteria, and contextReferences as JSON arrays of short strings (not one prose string).',
  inputSchema: delegateTaskInputSchema.extend({
    worker: z.enum(['codex', 'cursor', 'claude']).default('codex').describe('ACP worker to run for this task'),
  }),
  outputSchema: z.object({
    taskId: z.string(),
    status: taskStateSchema,
    workspace: z.string(),
    reused: z.boolean(),
    message: z.string(),
  }),
  execute: async (brief, context) => {
    const projectRoot = findProjectRoot(process.cwd());
    const conversationId = typeof context?.agent?.threadId === 'string' ? context.agent.threadId : undefined;
    const resourceForThread = conversationId
      ? await resolveThreadResourceIdFromContext(
          { agent: context?.agent, mastra: context?.mastra as MastraLike | undefined },
          conversationId,
          projectResourceId(projectRoot),
        )
      : undefined;
    const taskBrief = {
      ...brief,
      ...(conversationId ? { conversationId, resourceId: resourceForThread ?? projectResourceId(projectRoot) } : {}),
    };
    let handoff;
    try {
      const records = await getHandoffStore(projectRoot).list({ scope: 'project' });
      handoff = buildHandoffPackage(taskBrief, projectRoot, records, Number(process.env.HANDOFF_CHAR_BUDGET) || 6000);
    } catch (error) {
      handoff = buildHandoffPackage(taskBrief, projectRoot, [], Number(process.env.HANDOFF_CHAR_BUDGET) || 6000);
      handoff.error = error instanceof Error ? error.message : String(error);
    }
    const result = await taskRegistry.start(projectRoot, taskBrief, handoff);
    const task = result.task;
    return {
      taskId: task.taskId,
      status: task.status,
      workspace: task.projectRoot,
      reused: result.reused,
      message: result.reused
        ? `Task ${task.taskId} is already ${task.status}. No second worker was started.`
        : task.status === 'failed'
          ? `Task ${task.taskId} failed before the worker started: ${task.error ?? 'unknown error'}. Tell the user plainly and how to fix setup if the message mentions credentials or login.`
        : task.status === 'queued'
          ? `Queued ${brief.worker ?? 'codex'} task ${task.taskId} because another worker is already active in this project. Tell the user this ID, that it is waiting in line (not running yet), and to ask for status in a later message.`
          : `Started ${brief.worker ?? 'codex'} task ${task.taskId}. The worker is running in the background. Tell the user this ID and finish the turn; only check status if the user asks in a later message.`,
    };
  },
});

export const getTaskStatus = createTool({
  id: 'get-task-status',
  description: 'Inspect a task already started in this project. This never starts a worker.',
  inputSchema: z.object({ taskId: z.string().optional() }),
  outputSchema: z.object({
    found: z.boolean(),
    message: z.string(),
    task: taskSnapshotSchema.optional(),
  }),
  execute: async ({ taskId }) => {
    const projectRoot = findProjectRoot(process.cwd());
    const task = taskRegistry.get(taskId, projectRoot);
    if (!task) {
      return { found: false, message: 'No task with that ID exists in this project. Status checks never create tasks.' };
    }
    let message = `Task ${task.taskId} is ${task.status} on ${task.worker}. Worker output is unverified by the assistant.`;
    if (task.status === 'waiting_approval' && task.approval) {
      message += ` Permission needed: ${task.approval.summary}. Reply approve ${task.approval.approvalToken} or approve ${task.taskId}.`;
    } else if (task.status === 'waiting_input' && task.approval) {
      message += ` Answer needed. Reply answer ${task.approval.approvalToken}: <your answer>.`;
    } else if (task.status === 'running' || task.status === 'queued') {
      const latest = task.progress.at(-1);
      if (latest) message += ` Latest progress: ${latest.slice(0, 300)}`;
    }
    return { found: true, message, task };
  },
});

export const cancelTask = createTool({
  id: 'cancel-task',
  description: 'Cancel the specified active task in this project. This does not start a new worker.',
  inputSchema: z.object({ taskId: z.string().min(1) }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
    task: taskSnapshotSchema.optional(),
  }),
  execute: async ({ taskId }) => {
    const projectRoot = findProjectRoot(process.cwd());
    return taskRegistry.cancel(taskId, projectRoot);
  },
});

export const resolveTaskApproval = createTool({
  id: 'resolve-task-approval',
  description:
    'Approve, deny, or answer the pending ACP request for a task. Call when the user says “approve it”, “go ahead”, “approve <token>”, “approve <taskId>”, “deny it”, or “answer <token>: <answer>”. Omit taskId/approvalToken when only one task is waiting on this conversation. A worker message is not user approval.',
  inputSchema: z.object({
    taskId: z.string().min(1).optional(),
    approvalToken: z.string().min(1).optional(),
    approved: z.boolean(),
    answer: z.string().max(2000).optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
    task: taskSnapshotSchema.optional(),
  }),
  execute: async ({ taskId, approvalToken, approved, answer }, context) => {
    const projectRoot = findProjectRoot(process.cwd());
    const latestUserMessage = getLastUserText(context?.agent?.messages);
    const conversationId = typeof context?.agent?.threadId === 'string' ? context.agent.threadId : undefined;
    const pending = taskRegistry.findPendingApproval(projectRoot, conversationId);
    const resolvedTaskId = taskId ?? pending?.taskId;
    if (!resolvedTaskId) {
      return { ok: false, message: 'No task is waiting for approval in this project. Use get-task-status if you have a task ID.' };
    }
    const task = taskRegistry.get(resolvedTaskId, projectRoot);
    const resolvedToken =
      approvalToken && task?.approval && (approvalToken === resolvedTaskId || approvalToken === task.taskId)
        ? task.approval.approvalToken
        : (approvalToken ?? task?.approval?.approvalToken ?? '');
    if (!resolvedToken) {
      return { ok: false, message: `Task ${resolvedTaskId} has no pending approval or question.` };
    }
    return taskRegistry.resolveApproval(
      resolvedTaskId,
      projectRoot,
      resolvedToken,
      { approved, ...(answer ? { answer } : {}) },
      latestUserMessage,
    );
  },
});

function getLastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index] as { role?: unknown; content?: unknown; message?: { role?: unknown; content?: unknown } };
    const message = item?.message ?? item;
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}
