import type { TaskRecord, TaskStatus } from '../mastra/tools/task-registry.ts';
import { projectResourceId } from '../context/scope.ts';
import { buildWorkerEnvelope, signalIntakeService } from './intake-service.ts';

const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
const notifyProgressStatuses = new Set<TaskStatus>(['running', 'waiting_approval', 'waiting_input', 'queued']);

function summarizeTask(record: TaskRecord): string {
  const worker = record.brief.worker ?? 'codex';
  if (record.status === 'completed') {
    return `Worker ${worker} completed task ${record.taskId.slice(0, 8)}: ${record.objective.slice(0, 400)}`;
  }
  if (record.status === 'failed') {
    return `Worker ${worker} failed task ${record.taskId.slice(0, 8)}: ${record.error?.slice(0, 400) ?? 'unknown error'}`;
  }
  if (record.status === 'cancelled') {
    return `Worker ${worker} cancelled task ${record.taskId.slice(0, 8)}.`;
  }
  if (record.status === 'interrupted') {
    return `Task ${record.taskId.slice(0, 8)} was interrupted before completion.`;
  }
  if (record.status === 'waiting_approval' && record.approval) {
    const inWorkspace = record.approval.inWorkspace !== false;
    return inWorkspace
      ? `Task ${record.taskId} needs permission: ${record.approval.summary.slice(0, 240)}. Reply approve it, approve ${record.taskId}, or approve ${record.approval.approvalToken}.`
      : `Task ${record.taskId} needs out-of-workspace permission: ${record.approval.summary.slice(0, 240)}. Reply approve ${record.approval.approvalToken} or deny.`;
  }
  if (record.status === 'waiting_input' && record.approval) {
    return `Task ${record.taskId} needs an answer. Reply answer ${record.approval.approvalToken}: <your answer>.`;
  }
  const latest = record.progress.at(-1);
  return latest?.slice(0, 400) ?? `Task ${record.taskId.slice(0, 8)} is ${record.status}.`;
}

export async function notifyTaskLifecycle(record: TaskRecord, reason: 'status' | 'progress'): Promise<void> {
  const conversationId = record.brief.conversationId;
  const resourceId = record.brief.resourceId ?? projectResourceId(record.projectRoot);

  const worker = record.brief.worker ?? 'codex';
  const isTerminal = terminalStatuses.has(record.status);
  const isProgress = notifyProgressStatuses.has(record.status) && reason === 'progress';

  if (!isTerminal && !isProgress && reason === 'status') {
    if (!notifyProgressStatuses.has(record.status) && record.status !== 'cancelling') return;
  }
  if (!isTerminal && reason === 'progress' && !isProgress) return;
  if (record.status === 'cancelling') return;

  const category = isTerminal || (reason === 'status' && notifyProgressStatuses.has(record.status))
    ? 'worker_response'
    : 'worker_progress';

  const dedupeKey = isTerminal
    ? `worker:${record.taskId}:terminal:${record.status}`
    : `worker:${record.taskId}:progress`;

  const envelope = buildWorkerEnvelope({
    workspaceId: resourceId,
    conversationId,
    taskId: record.taskId,
    worker,
    category,
    dedupeKey,
    summary: summarizeTask(record),
    correlationId: record.taskId,
    payload: {
      taskId: record.taskId,
      status: record.status,
      objective: record.objective.slice(0, 500),
      ...(record.workerOutput ? { workerOutputPreview: record.workerOutput.slice(0, 800) } : {}),
      ...(record.error ? { error: record.error.slice(0, 500) } : {}),
      ...(category === 'worker_progress' ? { coalesceKey: `worker:${record.taskId}:progress` } : {}),
    },
  });

  await signalIntakeService.acceptAndDispatch(envelope, {
    workspaceId: resourceId,
    ...(conversationId ? { conversationId } : {}),
  });
}

export function wireWorkerTaskSignals(
  registry: { setLifecycleListener(listener: (record: TaskRecord, reason: 'status' | 'progress') => void): void },
): void {
  registry.setLifecycleListener((record, reason) => {
    void notifyTaskLifecycle(record, reason).catch((error) => {
      console.warn('[signals] worker notification failed:', error instanceof Error ? error.message : error);
    });
  });
}