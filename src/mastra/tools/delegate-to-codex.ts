import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ACP_UNHANDLED, AcpWorkerClient, type AcpLaunch } from '../../integrations/acp/client.ts';
import { codexAcpLaunch } from '../../integrations/acp/providers.ts';
import { choosePermissionOption, inspectPermissionRequest, taskFingerprint } from '../../policy/workspace.ts';

const approvalTtlMs = 5 * 60 * 1000;

const approvalPayloadSchema = z.object({
  approvalToken: z.string(),
  projectRoot: z.string(),
  taskFingerprint: z.string(),
  kind: z.enum(['permission', 'question']),
  requestFingerprint: z.string().optional(),
  operation: z.string().optional(),
  summary: z.string(),
  expiresAt: z.number(),
});

const resumeSchema = z.object({
  approvalToken: z.string(),
  approved: z.boolean(),
  answer: z.string().optional(),
});

export function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'src', 'mastra'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find the Mastra project root above ${start}`);
    }
    current = parent;
  }
}

function formatWorkerQuestion(params: Record<string, unknown>): string {
  const question = [params.question, params.prompt, params.message, params.title]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  const options = Array.isArray(params.options)
    ? params.options
        .map((option) => {
          if (typeof option === 'string') return option;
          if (!option || typeof option !== 'object') return '';
          const value = option as Record<string, unknown>;
          return [value.label, value.title, value.name].find((item): item is string => typeof item === 'string') ?? '';
        })
        .filter(Boolean)
    : [];
  if (question) return `${question}${options.length ? `\nOptions: ${options.join('; ')}` : ''}`.slice(0, 3000);
  return JSON.stringify(params).slice(0, 3000);
}

type DelegationContext = {
  abortSignal?: AbortSignal;
  onProgress?: (text: string) => void;
  onApprovalRequested?: (payload: z.infer<typeof approvalPayloadSchema>) => Promise<void>;
  agent?: {
    suspend?: (payload: z.infer<typeof approvalPayloadSchema>) => Promise<void>;
    resumeData?: unknown;
    suspendPayload?: unknown;
  };
};

type DelegationDependencies = {
  startClient?: (launch: AcpLaunch) => Promise<AcpWorkerClient>;
};

export async function runCodexDelegation(
  task: string,
  projectRoot: string,
  context: DelegationContext = {},
  dependencies: DelegationDependencies = {},
) {
  const agentContext = context.agent;
  const inputTaskFingerprint = taskFingerprint(task);
  const suspendedPayload = agentContext?.suspendPayload
    ? approvalPayloadSchema.safeParse(agentContext.suspendPayload).data
    : undefined;
  const resume = agentContext?.resumeData
    ? resumeSchema.safeParse(agentContext.resumeData).data
    : undefined;

  if (agentContext?.resumeData && (!resume || !suspendedPayload || resume.approvalToken !== suspendedPayload.approvalToken)) {
    return { response: 'Approval could not be verified. Start the delegation again.', stopReason: 'approval_invalid' };
  }
  if (suspendedPayload && (suspendedPayload.projectRoot !== projectRoot || suspendedPayload.taskFingerprint !== inputTaskFingerprint)) {
    return { response: 'Approval scope no longer matches this project and task. Start the delegation again.', stopReason: 'approval_scope_changed' };
  }
  if (resume && suspendedPayload && Date.now() > suspendedPayload.expiresAt) {
    return { response: 'The approval request expired. Start the delegation again if you still want this action.', stopReason: 'approval_expired' };
  }
  if (resume && !resume.approved && suspendedPayload?.kind === 'permission') {
    return { response: 'Codex permission was denied. No out-of-scope action was authorized.', stopReason: 'permission_denied' };
  }
  if (resume && suspendedPayload?.kind === 'question' && !resume.approved) {
    return { response: 'The worker question was cancelled. No further delegation was performed.', stopReason: 'question_cancelled' };
  }
  if (resume && suspendedPayload?.kind === 'question' && !resume.answer?.trim()) {
    return { response: 'No answer was provided to the worker. Start the delegation again when you are ready.', stopReason: 'question_unanswered' };
  }

  const client = await (dependencies.startClient ?? AcpWorkerClient.start)(codexAcpLaunch(projectRoot));
  let response = '';
  let sessionId = '';
  let approvalPending = false;
  let permissionRejected = false;
  let questionRepeated = false;
  client.events.on('update', (message) => {
    if (message.method !== 'session/update') return;
    const update = message.params.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate !== 'agent_message_chunk') return;
    const content = update.content as Record<string, unknown> | undefined;
    if (typeof content?.text === 'string') {
      response += content.text;
      context.onProgress?.(content.text);
    }
  });
  try {
    sessionId = await client.newSession(projectRoot);
    const userAnswer = resume?.answer?.trim();
    const pauseForApproval = async (payload: z.infer<typeof approvalPayloadSchema>) => {
      if (agentContext?.suspend) {
        await agentContext.suspend(payload);
      } else if (context.onApprovalRequested) {
        await context.onApprovalRequested(payload);
      } else {
        return false;
      }
      approvalPending = true;
      // Cancellation releases the ACP prompt while its approval state is persisted.
      void client.cancel(sessionId);
      return true;
    };
    client.setClientRequestHandler(async ({ method, params }) => {
      if (method === 'session/request_permission') {
        const scope = inspectPermissionRequest(projectRoot, method, params);
        const approvedScope = resume?.approved && suspendedPayload?.kind === 'permission'
          && suspendedPayload.requestFingerprint === scope.fingerprint
          && suspendedPayload.projectRoot === projectRoot
          && suspendedPayload.taskFingerprint === inputTaskFingerprint
          && Date.now() <= suspendedPayload.expiresAt;
        if (scope.automaticallyAllowed || approvedScope) {
          const choice = choosePermissionOption(params, true);
          if ((choice as { outcome?: { outcome?: string } }).outcome?.outcome === 'cancelled') permissionRejected = true;
          return choice;
        }
        const payload = {
          approvalToken: randomUUID(),
          projectRoot,
          taskFingerprint: inputTaskFingerprint,
          kind: 'permission' as const,
          requestFingerprint: scope.fingerprint,
          operation: scope.operation,
          summary: `${scope.summary}. ${scope.reason ?? 'This action requires approval.'}`,
          expiresAt: Date.now() + approvalTtlMs,
        };
        if (!(await pauseForApproval(payload))) {
          permissionRejected = true;
          return choosePermissionOption(params, false);
        }
        return new Promise<never>(() => {});
      }

      if (method === 'cursor/ask_question') {
        if (userAnswer && suspendedPayload?.kind === 'question') {
          questionRepeated = true;
          return { outcome: { outcome: 'cancelled' } };
        }
        const payload = {
          approvalToken: randomUUID(),
          projectRoot,
          taskFingerprint: inputTaskFingerprint,
          kind: 'question' as const,
          summary: formatWorkerQuestion(params),
          expiresAt: Date.now() + approvalTtlMs,
        };
        if (!(await pauseForApproval(payload))) {
          questionRepeated = true;
          return { outcome: { outcome: 'cancelled' } };
        }
        return new Promise<never>(() => {});
      }

      if (method === 'cursor/create_plan') return { outcome: { outcome: 'cancelled' } };
      return ACP_UNHANDLED;
    });

    let promptTask = task;
    if (suspendedPayload?.kind === 'question' && resume?.approved && userAnswer) {
      promptTask = `${task}\n\nUser response to the worker's question: ${userAnswer}`;
    }
    const promptResponse = await client.prompt(
      sessionId,
      `Complete this task in the current project workspace only: ${projectRoot}. You may create or edit files in this directory when the task asks for it. Do not access or modify files outside this workspace. Avoid destructive commands and do not change unrelated files. Report what you actually did and any verification performed.\n\nTask: ${promptTask}`,
      context.abortSignal,
    );

    if (approvalPending) return undefined;
    if (permissionRejected) {
      return { response: 'Codex permission was cancelled because the request could not be safely authorized.', stopReason: 'permission_unavailable' };
    }
    if (questionRepeated) {
      return { response: 'The worker asked another question after the supplied answer. Delegation stopped for review.', stopReason: 'question_repeated' };
    }
    if (promptResponse.stopReason === 'cancelled') {
      return { response: 'Codex delegation was cancelled.', stopReason: 'cancelled' };
    }

    return {
      response: response.trim() || 'Codex finished without a text response.',
      stopReason: String(promptResponse.stopReason ?? 'unknown'),
    };
  } catch (error) {
    if (context.abortSignal?.aborted) {
      return { response: 'Codex delegation was cancelled.', stopReason: 'cancelled' };
    }
    throw error;
  } finally {
    client.close();
  }
}

/** Run one Codex task using ACP, scoped to this project workspace. */
export const delegateToCodex = createTool({
  id: 'delegate-to-codex',
  description:
    'Delegate a bounded task in the current project to the locally authenticated Codex agent. Codex may read and edit files inside this project workspace. Use for project changes and inspections; wait for the actual result before reporting completion.',
  inputSchema: z.object({
    task: z.string().min(1).max(4000).describe('A specific task for Codex to perform'),
  }),
  outputSchema: z.object({
    response: z.string(),
    stopReason: z.string(),
  }),
  suspendSchema: approvalPayloadSchema,
  resumeSchema,
  execute: async ({ task }, context) => {
    const projectRoot = findProjectRoot(process.env.ASSISTANT_PROJECT_ROOT ?? process.cwd());
    return runCodexDelegation(task, projectRoot, context);
  },
});
