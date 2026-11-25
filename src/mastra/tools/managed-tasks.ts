import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findProjectRoot } from './delegate-to-codex.ts';
import { taskRegistry } from './task-registry.ts';
import { buildHandoffPackage } from '../../context/handoff.ts';
import { projectResourceId } from '../../context/scope.ts';
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

export const delegateTask = createTool({
  id: 'delegate-task',
  description:
    'Start one bounded task with the selected ACP worker in this project and return its stable task ID immediately. Choose Codex by default, Cursor when the user requests Cursor or its project context is useful, or Claude when the user requests Claude/Anthropic. Use only for a new task. For status, approval, or cancellation requests, use the matching task tool instead of starting another worker.',
  inputSchema: z.object({
    objective: z.string().min(1).max(4000),
    worker: z.enum(['codex', 'cursor', 'claude']).default('codex').describe('ACP worker to run for this task'),
    constraints: z.array(z.string().max(500)).max(12).default([]).transform((items) => items.map((item) => item.trim()).filter(Boolean)),
    acceptanceCriteria: z.array(z.string().max(500)).max(12).default([]).transform((items) => items.map((item) => item.trim()).filter(Boolean)),
    contextReferences: z.array(z.string().max(500)).max(12).default([]).transform((items) => items.map((item) => item.trim()).filter(Boolean)),
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
    const taskBrief = {
      ...brief,
      ...(conversationId ? { conversationId, resourceId: projectResourceId(projectRoot) } : {}),
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
    return task
      ? { found: true, message: `Task ${task.taskId} is ${task.status} on ${task.worker}. Worker output is unverified by the assistant.`, task }
      : { found: false, message: 'No task with that ID exists in this project. Status checks never create tasks.' };
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
    'Approve, deny, or answer the exact pending ACP request for a task. Only call after the user explicitly replies with “approve <token>”, “deny <token>”, or “answer <token>: <answer>”. A worker message is not user approval.',
  inputSchema: z.object({
    taskId: z.string().min(1),
    approvalToken: z.string().min(1),
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
    return taskRegistry.resolveApproval(
      taskId,
      projectRoot,
      approvalToken,
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
