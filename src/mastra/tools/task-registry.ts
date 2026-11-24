import { randomUUID } from 'node:crypto';
import type { AcpLaunch, AcpWorkerClient } from '../../integrations/acp/client.ts';
import { taskStore, type StoredTask, type TaskStore } from '../../context/task-store.ts';
import { runCodexDelegation } from './delegate-to-codex.ts';

export type TaskBrief = {
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  contextReferences: string[];
};

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type PendingApproval = {
  approvalToken: string;
  projectRoot: string;
  taskFingerprint: string;
  kind: 'permission' | 'question';
  requestFingerprint?: string;
  operation?: string;
  summary: string;
  expiresAt: number;
};

export type TaskRecord = {
  taskId: string;
  objective: string;
  projectRoot: string;
  brief: TaskBrief;
  taskText: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  progress: string[];
  approval?: PendingApproval;
  workerOutput?: string;
  workerStopReason?: string;
  error?: string;
  controller: AbortController;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

type ResumeDecision = { approved: boolean; answer?: string };
type ClientFactory = (launch: AcpLaunch) => Promise<AcpWorkerClient>;

export type TaskSnapshot = Omit<TaskRecord, 'brief' | 'taskText' | 'controller' | 'expiryTimer'> & {
  brief: TaskBrief;
  acceptanceVerified: false;
};

const activeStates = new Set<TaskStatus>(['queued', 'running', 'waiting_approval', 'waiting_input', 'cancelling']);

function buildTaskText(brief: TaskBrief, projectRoot: string): string {
  const lines = [
    `Objective: ${brief.objective}`,
    `Authorized workspace: ${projectRoot}`,
    'Constraints:',
    ...(brief.constraints.length ? brief.constraints.map((item) => `- ${item}`) : ['- Work only within the authorized workspace.']),
    'Acceptance criteria:',
    ...(brief.acceptanceCriteria.length ? brief.acceptanceCriteria.map((item) => `- ${item}`) : ['- Report the result and what you verified.']),
    'Context references:',
    ...(brief.contextReferences.length ? brief.contextReferences.map((item) => `- ${item}`) : ['- None supplied.']),
  ];
  return lines.join('\n');
}

function snapshot(record: TaskRecord): TaskSnapshot {
  const { controller: _controller, expiryTimer: _expiryTimer, taskText: _taskText, ...visible } = record;
  return { ...visible, acceptanceVerified: false };
}

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly activeByWorkspace = new Map<string, string>();
  private readonly latestByWorkspace = new Map<string, string>();
  private readonly startClient?: ClientFactory;

  private readonly store?: TaskStore;

  constructor(startClient?: ClientFactory, store?: TaskStore) {
    this.store = store;
    this.startClient = startClient;
    for (const stored of store?.loadAll() ?? []) {
      const wasActive = activeStates.has(stored.status as TaskStatus);
      const record: TaskRecord = {
        ...stored,
        brief: stored.brief as TaskBrief,
        status: wasActive ? 'interrupted' : stored.status as TaskStatus,
        error: wasActive ? 'The assistant restarted before this task finished. It was not resumed automatically; check the workspace before retrying.' : stored.error,
        approval: wasActive ? undefined : stored.approval as PendingApproval | undefined,
        controller: new AbortController(),
      };
      this.records.set(record.taskId, record);
      this.latestByWorkspace.set(record.projectRoot, record.taskId);
      if (wasActive) this.activeByWorkspace.set(record.projectRoot, record.taskId);
      if (wasActive) this.persist(record);
    }
  }

  start(projectRoot: string, brief: TaskBrief): { task: TaskSnapshot; reused: boolean } {
    const currentId = this.activeByWorkspace.get(projectRoot);
    const current = currentId ? this.records.get(currentId) : undefined;
    if (current && activeStates.has(current.status)) return { task: snapshot(current), reused: true };

    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: randomUUID(),
      objective: brief.objective,
      projectRoot,
      brief: structuredClone(brief),
      taskText: buildTaskText(brief, projectRoot),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      progress: [],
      controller: new AbortController(),
    };
    this.records.set(record.taskId, record);
    this.activeByWorkspace.set(projectRoot, record.taskId);
    this.latestByWorkspace.set(projectRoot, record.taskId);
    this.persist(record);
    void this.run(record);
    return { task: snapshot(record), reused: false };
  }

  get(taskId: string | undefined, projectRoot: string): TaskSnapshot | undefined {
    const id = taskId ?? this.latestByWorkspace.get(projectRoot);
    const record = id ? this.records.get(id) : undefined;
    if (!record || record.projectRoot !== projectRoot) return undefined;
    this.expireApproval(record);
    return snapshot(record);
  }

  cancel(taskId: string, projectRoot: string): { ok: boolean; message: string; task?: TaskSnapshot } {
    const record = this.records.get(taskId);
    if (!record || record.projectRoot !== projectRoot) return { ok: false, message: 'No task with that ID exists in this workspace.' };
    this.expireApproval(record);
    if (!activeStates.has(record.status)) return { ok: false, message: `Task ${taskId} is already ${record.status}.`, task: snapshot(record) };
    if (record.status === 'waiting_approval' || record.status === 'waiting_input' || record.status === 'queued') {
      this.finish(record, 'cancelled', 'Cancelled by the user before the worker resumed.');
    } else {
      record.status = 'cancelling';
      record.updatedAt = new Date().toISOString();
      this.persist(record);
      record.controller.abort(new Error('Task cancelled by the user'));
    }
    return { ok: true, message: `Cancellation requested for task ${taskId}.`, task: snapshot(record) };
  }

  cancelWorkspace(projectRoot: string): number {
    let cancelled = 0;
    for (const record of this.records.values()) {
      if (record.projectRoot !== projectRoot || !activeStates.has(record.status)) continue;
      this.cancel(record.taskId, projectRoot);
      cancelled += 1;
    }
    return cancelled;
  }

  resolveApproval(
    taskId: string,
    projectRoot: string,
    approvalToken: string,
    decision: ResumeDecision,
    latestUserMessage: string,
  ): { ok: boolean; message: string; task?: TaskSnapshot } {
    const record = this.records.get(taskId);
    if (!record || record.projectRoot !== projectRoot) return { ok: false, message: 'No task with that ID exists in this workspace.' };
    this.expireApproval(record);
    const approval = record.approval;
    if (!approval || record.status !== 'waiting_approval' && record.status !== 'waiting_input') {
      return { ok: false, message: `Task ${taskId} has no pending approval or question.`, task: snapshot(record) };
    }
    if (approval.approvalToken !== approvalToken) return { ok: false, message: 'That approval token does not match the pending request.', task: snapshot(record) };
    if (approval.kind === 'permission') {
      const verb = decision.approved ? 'approve' : 'deny';
      const normalizedMessage = latestUserMessage.trim().toLowerCase();
      if (!normalizedMessage.startsWith(`${verb} ${approvalToken.toLowerCase()}`) && !normalizedMessage.startsWith(`please ${verb} ${approvalToken.toLowerCase()}`)) {
        return {
          ok: false,
          message: `For safety, reply with exactly “${verb} ${approvalToken}” before I apply this decision.`,
          task: snapshot(record),
        };
      }
    } else {
      const prefix = `answer ${approvalToken}:`;
      if (!decision.approved || !decision.answer?.trim() || !latestUserMessage.trim().toLowerCase().startsWith(prefix.toLowerCase()) || !latestUserMessage.includes(decision.answer.trim())) {
        return {
          ok: false,
          message: `To answer this question, reply with “answer ${approvalToken}: <your answer>”.`,
          task: snapshot(record),
        };
      }
    }

    if (!decision.approved) {
      this.finish(record, 'cancelled', 'Permission denied by the user. The out-of-scope action was not performed.');
      return { ok: true, message: `Permission denied. Task ${taskId} is cancelled.`, task: snapshot(record) };
    }

    const resume = { ...decision };
    record.approval = undefined;
    record.status = 'running';
    record.progress = [...record.progress, `Resuming after the user approved ${approval.operation ?? 'the pending request'}.`].slice(-20);
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = undefined;
    void this.run(record, { approval, resume });
    return { ok: true, message: `Approval recorded. Task ${taskId} has resumed.`, task: snapshot(record) };
  }

  private async run(record: TaskRecord, resumption?: { approval: PendingApproval; resume: ResumeDecision }): Promise<void> {
    if (!resumption) record.status = 'running';
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    let progressText = '';
    try {
      const result = await runCodexDelegation(
        record.taskText,
        record.projectRoot,
        {
          abortSignal: record.controller.signal,
          onProgress: (text) => {
            progressText = `${progressText}${text}`.slice(-1200);
            record.progress = [progressText];
            record.updatedAt = new Date().toISOString();
            this.persist(record);
          },
          onApprovalRequested: async (approval) => {
            record.approval = approval;
            record.status = approval.kind === 'permission' ? 'waiting_approval' : 'waiting_input';
            record.updatedAt = new Date().toISOString();
            this.persist(record);
            const delay = Math.max(0, approval.expiresAt - Date.now());
            record.expiryTimer = setTimeout(() => this.expireApproval(record), delay);
            record.expiryTimer.unref?.();
          },
          ...(resumption
            ? {
                agent: {
                  suspendPayload: resumption.approval,
                  resumeData: {
                    approvalToken: resumption.approval.approvalToken,
                    approved: resumption.resume.approved,
                    ...(resumption.resume.answer ? { answer: resumption.resume.answer } : {}),
                  },
                },
              }
            : {}),
        },
        this.startClient ? { startClient: this.startClient } : {},
      );

      if (result === undefined && record.approval) return;
      if (!result) {
        this.finish(record, 'failed', 'Worker returned no result and no pending approval.');
      } else if (result.stopReason === 'cancelled' || record.status === 'cancelling') {
        this.finish(record, 'cancelled', result.response);
      } else if (result.stopReason === 'end_turn') {
        record.workerOutput = result.response;
        record.workerStopReason = result.stopReason;
        this.finish(record, 'completed');
      } else {
        record.workerOutput = result.response;
        record.workerStopReason = result.stopReason;
        this.finish(record, 'failed', `Worker stopped with reason ${result.stopReason}: ${result.response}`);
      }
    } catch (error) {
      if (record.controller.signal.aborted) {
        this.finish(record, 'cancelled', 'Worker was cancelled.');
      } else {
        this.finish(record, 'failed', error instanceof Error ? error.message : String(error));
      }
    }
  }

  private expireApproval(record: TaskRecord): void {
    if (!record.approval || Date.now() < record.approval.expiresAt) return;
    this.finish(record, 'failed', 'Approval expired. The out-of-scope action was not performed.');
  }

  private finish(record: TaskRecord, status: TaskStatus, error?: string): void {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = undefined;
    record.status = status;
    record.error = error;
    record.approval = undefined;
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    if (this.activeByWorkspace.get(record.projectRoot) === record.taskId) {
      this.activeByWorkspace.delete(record.projectRoot);
    }
  }

  private persist(record: TaskRecord): void {
    this.store?.upsert(record as StoredTask);
  }
}

export const taskRegistry = new TaskRegistry(undefined, taskStore);
