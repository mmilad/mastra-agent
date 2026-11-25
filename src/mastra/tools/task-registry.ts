import { randomUUID } from 'node:crypto';
import type { AcpLaunch, AcpWorkerClient } from '../../integrations/acp/client.ts';
import { taskStore, type StoredTask, type TaskStore } from '../../context/task-store.ts';
import { runWorkerDelegation, type WorkerProvider } from './delegate-to-codex.ts';
import type { HandoffPackage } from '../../context/handoff.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { acpSpawnSpec } from '../../integrations/acp/spawn-spec.ts';

const execFileAsync = promisify(execFile);

export type TaskBrief = {
  worker?: WorkerProvider;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  contextReferences: string[];
  conversationId?: string;
  resourceId?: string;
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
  handoff?: HandoffPackage;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  progress: string[];
  approval?: PendingApproval;
  workerOutput?: string;
  workerStopReason?: string;
  evidence: { changedFiles: string[]; verified: boolean; workerClaimedSuccess: boolean };
  error?: string;
  controller: AbortController;
  expiryTimer?: ReturnType<typeof setTimeout>;
};

type ResumeDecision = { approved: boolean; answer?: string };
type ClientFactory = (launch: AcpLaunch) => Promise<AcpWorkerClient>;

export type TaskSnapshot = Omit<TaskRecord, 'brief' | 'taskText' | 'controller' | 'expiryTimer'> & {
  brief: TaskBrief;
  worker: WorkerProvider;
  acceptanceVerified: false;
};

type RegistryOptions = { timeoutMs?: number; preflight?: (projectRoot: string, worker: WorkerProvider) => Promise<void> };

const activeStates = new Set<TaskStatus>(['queued', 'running', 'waiting_approval', 'waiting_input', 'cancelling']);

function buildTaskText(brief: TaskBrief, projectRoot: string, handoff: HandoffPackage): string {
  const lines = [
    `Objective: ${brief.objective}`,
    `Authorized workspace: ${projectRoot}`,
    'Constraints:',
    ...(brief.constraints.length ? brief.constraints.map((item) => `- ${item}`) : ['- Work only within the authorized workspace.']),
    'Acceptance criteria:',
    ...(brief.acceptanceCriteria.length ? brief.acceptanceCriteria.map((item) => `- ${item}`) : ['- Report the result and what you verified.']),
    'Context references:',
    ...(brief.contextReferences.length ? brief.contextReferences.map((item) => `- ${item}`) : ['- None supplied.']),
    '',
    'Handoff package (supplemental project context):',
    JSON.stringify(handoff, null, 2),
  ];
  return lines.join('\n');
}

function snapshot(record: TaskRecord): TaskSnapshot {
  const { controller: _controller, expiryTimer: _expiryTimer, taskText: _taskText, ...visible } = record;
  return { ...visible, worker: record.brief.worker ?? 'codex', acceptanceVerified: false };
}

async function defaultPreflight(projectRoot: string, worker: WorkerProvider): Promise<void> {
  if (worker === 'claude') {
    const { assertClaudeWorkerAuth } = await import('../../integrations/acp/claude-auth.ts');
    await assertClaudeWorkerAuth();
  }
  const { workerAcpLaunch } = await import('../../integrations/acp/providers.ts');
  const launch = workerAcpLaunch(worker, projectRoot);
  const executable = launch.command.includes('/') || launch.command.includes('\\')
    ? existsSync(launch.command)
    : (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
        .some((directory) => existsSync(join(directory, launch.command)) || process.platform === 'win32' &&
          (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').some((extension) => existsSync(join(directory, `${launch.command}${extension}`))));
  if (!executable) throw new Error(`Worker command not found: ${launch.command}`);
  try {
    const spec = acpSpawnSpec(launch, [...launch.args, '--version']);
    await execFileAsync(spec.command, spec.args, {
      cwd: projectRoot,
      timeout: 3000,
      windowsHide: true,
      ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`Worker command not found: ${launch.command}`);
    // Some ACP adapters do not implement --version. Spawn/authentication validation remains in ACP startup.
    if (code === 'ETIMEDOUT') throw new Error(`Worker preflight timed out: ${launch.command} --version`);
  }
}

async function gitFiles(projectRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectRoot, timeout: 3000, windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3)).sort();
  } catch { return []; }
}

async function changedFiles(projectRoot: string, before: string[]): Promise<string[]> {
  const after = await gitFiles(projectRoot);
  return [...new Set([...before, ...after])].filter((file) => before.includes(file) !== after.includes(file)).sort();
}

export class TaskRegistry {
  private readonly records = new Map<string, TaskRecord>();
  private readonly activeByWorkspace = new Map<string, string>();
  private readonly queues = new Map<string, string[]>();
  private readonly latestByWorkspace = new Map<string, string>();
  private readonly startClient?: ClientFactory;

  private readonly store?: TaskStore;
  private readonly timeoutMs: number;
  private readonly preflight: (projectRoot: string, worker: WorkerProvider) => Promise<void>;
  private lifecycleListener?: (record: TaskRecord, reason: 'status' | 'progress') => void;

  constructor(startClient?: ClientFactory, store?: TaskStore, options: RegistryOptions = {}) {
    this.store = store;
    this.startClient = startClient;
    const configuredTimeout = Number(process.env.TASK_TIMEOUT_MS ?? 15 * 60 * 1000);
    this.timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 15 * 60 * 1000);
    this.preflight = options.preflight ?? defaultPreflight;
    for (const stored of store?.loadAll() ?? []) {
      const wasActive = activeStates.has(stored.status as TaskStatus) && stored.status !== 'queued';
      const record: TaskRecord = {
        ...stored,
        brief: stored.brief as TaskBrief,
        evidence: { changedFiles: [], verified: false, workerClaimedSuccess: false },
        status: wasActive ? 'interrupted' : stored.status as TaskStatus,
        error: wasActive ? 'The assistant restarted before this task finished. It was not resumed automatically; check the workspace before retrying.' : stored.error,
        approval: wasActive ? undefined : stored.approval as PendingApproval | undefined,
        controller: new AbortController(),
      };
      this.records.set(record.taskId, record);
      this.latestByWorkspace.set(record.projectRoot, record.taskId);
      if (stored.status === 'queued') {
        const queue = this.queues.get(record.projectRoot) ?? [];
        queue.push(record.taskId);
        this.queues.set(record.projectRoot, queue);
      }
      if (wasActive) this.persist(record);
    }
    for (const projectRoot of this.queues.keys()) {
      this.startNext(projectRoot);
    }
  }

  setLifecycleListener(listener: (record: TaskRecord, reason: 'status' | 'progress') => void): void {
    this.lifecycleListener = listener;
  }

  private emitLifecycle(record: TaskRecord, reason: 'status' | 'progress'): void {
    this.lifecycleListener?.(record, reason);
  }

  async start(projectRoot: string, brief: TaskBrief, handoff?: HandoffPackage): Promise<{ task: TaskSnapshot; reused: boolean }> {
    // An identical request while the same task is active is a retry: return that task instead of queueing a copy.
    const activeId = this.activeByWorkspace.get(projectRoot);
    const activeRecord = activeId ? this.records.get(activeId) : undefined;
    if (activeRecord && activeStates.has(activeRecord.status) && JSON.stringify(activeRecord.brief) === JSON.stringify(brief)) {
      return { task: snapshot(activeRecord), reused: true };
    }
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: randomUUID(),
      objective: brief.objective,
      projectRoot,
      brief: structuredClone(brief),
      ...(handoff ? { handoff: structuredClone(handoff) } : {}),
      taskText: handoff ? buildTaskText(brief, projectRoot, handoff) : brief.objective,
      status: this.activeByWorkspace.has(projectRoot) ? 'queued' : 'running',
      createdAt: now,
      updatedAt: now,
      progress: [],
      evidence: { changedFiles: [], verified: false, workerClaimedSuccess: false },
      controller: new AbortController(),
    };
    this.records.set(record.taskId, record);
    this.latestByWorkspace.set(projectRoot, record.taskId);
    this.persist(record);
    if (record.status === 'queued') {
      const queue = this.queues.get(projectRoot) ?? [];
      queue.push(record.taskId);
      this.queues.set(projectRoot, queue);
    } else {
      this.activeByWorkspace.set(projectRoot, record.taskId);
      try {
        await this.preflight(record.projectRoot, record.brief.worker ?? 'codex');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.finish(record, 'failed', message);
        return { task: snapshot(record), reused: false };
      }
      void this.run(record, { skipPreflight: true });
    }
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
    void this.run(record, { resumption: { approval, resume } });
    return { ok: true, message: `Approval recorded. Task ${taskId} has resumed.`, task: snapshot(record) };
  }

  private async run(
    record: TaskRecord,
    options: {
      resumption?: { approval: PendingApproval; resume: ResumeDecision };
      skipPreflight?: boolean;
    } = {},
  ): Promise<void> {
    const resumption = options.resumption;
    if (!resumption) record.status = 'running';
    record.updatedAt = new Date().toISOString();
    this.persist(record);
    let progressText = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let beforeFiles: string[] = [];
    try {
      if (!resumption && !options.skipPreflight) {
        await this.preflight(record.projectRoot, record.brief.worker ?? 'codex');
        beforeFiles = await gitFiles(record.projectRoot);
        record.evidence.changedFiles = [];
        timeout = setTimeout(() => record.controller.abort(new Error('Task timed out')), this.timeoutMs);
        timeout.unref?.();
      }
      const result = await runWorkerDelegation(
        record.taskText,
        record.projectRoot,
        record.brief.worker ?? 'codex',
        {
          abortSignal: record.controller.signal,
          onProgress: (text) => {
            progressText = `${progressText}${text}`.slice(-1200);
            record.progress = [progressText];
            record.updatedAt = new Date().toISOString();
            this.persist(record);
            this.emitLifecycle(record, 'progress');
          },
          onApprovalRequested: async (approval) => {
            record.approval = approval;
            record.status = approval.kind === 'permission' ? 'waiting_approval' : 'waiting_input';
            record.updatedAt = new Date().toISOString();
            this.persist(record);
            this.emitLifecycle(record, 'status');
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
        const abortReason = record.controller.signal.reason;
        this.finish(record, 'cancelled', record.controller.signal.aborted && abortReason instanceof Error ? abortReason.message : result.response);
      } else if (result.stopReason === 'end_turn') {
        record.workerOutput = result.response;
        record.workerStopReason = result.stopReason;
        record.evidence.workerClaimedSuccess = true;
        record.evidence.changedFiles = await changedFiles(record.projectRoot, beforeFiles);
        this.finish(record, 'completed');
      } else {
        record.workerOutput = result.response;
        record.workerStopReason = result.stopReason;
        this.finish(record, 'failed', `Worker stopped with reason ${result.stopReason}: ${result.response}`);
      }
    } catch (error) {
      if (timeout) clearTimeout(timeout);
      record.evidence.changedFiles = await changedFiles(record.projectRoot, beforeFiles);
      if (record.controller.signal.aborted) {
        this.finish(record, 'cancelled', record.controller.signal.reason instanceof Error ? record.controller.signal.reason.message : 'Worker was cancelled.');
      } else {
        this.finish(record, 'failed', error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.activeByWorkspace.get(record.projectRoot) === record.taskId && !activeStates.has(record.status)) {
        this.activeByWorkspace.delete(record.projectRoot);
        this.startNext(record.projectRoot);
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
    this.emitLifecycle(record, 'status');
    if (this.activeByWorkspace.get(record.projectRoot) === record.taskId) {
      this.activeByWorkspace.delete(record.projectRoot);
    }
    if ((record.status === 'cancelled' || record.status === 'failed' || record.status === 'completed') && !this.activeByWorkspace.has(record.projectRoot)) this.startNext(record.projectRoot);
  }

  private startNext(projectRoot: string): void {
    if (this.activeByWorkspace.has(projectRoot)) return;
    const queue = this.queues.get(projectRoot) ?? [];
    while (queue.length) {
      const next = this.records.get(queue.shift()!);
      if (!next || next.status !== 'queued') continue;
      this.queues.set(projectRoot, queue);
      this.activeByWorkspace.set(projectRoot, next.taskId);
      next.status = 'running';
      next.updatedAt = new Date().toISOString();
      this.persist(next);
      void this.run(next);
      return;
    }
    this.queues.delete(projectRoot);
  }

  private persist(record: TaskRecord): void {
    this.store?.upsert(record as StoredTask);
  }
}

export const taskRegistry = new TaskRegistry(undefined, taskStore);
