import type { Agent } from '@mastra/core/agent';
import { findWorkspaceRoot, projectResourceId } from '../context/scope.ts';
import { triageUserPrompt } from '../supervisor/triage.ts';
import { buildUserPromptEnvelope } from './user-prompt.ts';
import { signalIntakeService } from './intake-service.ts';
import { resolveThreadResourceId } from '../context/thread-resource.ts';
import { tryApplyApprovalUserMessage } from '../mastra/tools/approval-routing.ts';
import type { AcceptResult } from './intake-service.ts';

type MemoryOpts = {
  thread?: string | { id?: string };
  resource?: string;
};

function threadId(memory?: MemoryOpts): string | undefined {
  if (!memory?.thread) return undefined;
  return typeof memory.thread === 'string' ? memory.thread : memory.thread.id;
}

function resourceId(memory?: MemoryOpts): string {
  return memory?.resource ?? projectResourceId(findWorkspaceRoot());
}

async function alignMemoryResource(agent: Agent, memory?: MemoryOpts): Promise<MemoryOpts | undefined> {
  if (!memory) return memory;
  const conversationId = threadId(memory);
  if (!conversationId) return memory;
  const resource = await resolveThreadResourceId(agent, conversationId, resourceId(memory));
  return { ...memory, resource };
}

function textFromMessages(messages: unknown): string {
  if (typeof messages === 'string') return messages;
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i] as { role?: string; content?: unknown };
    if (row?.role !== 'user') continue;
    if (typeof row.content === 'string') return row.content;
  }
  return '';
}

function memoryFromOptions(options: unknown): MemoryOpts | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const memory = (options as { memory?: MemoryOpts }).memory;
  return memory;
}

function studioReplyFromDispatch(result: AcceptResult): string {
  if (!result.ok) return result.message;
  if (result.responseText?.trim()) return result.responseText.trim();
  if (result.branch) {
    return `Supervisor routed this message to the ${result.branch} branch. The turn was handled through the intake supervisor (not a duplicate agent run).`;
  }
  if (result.dispatched) return 'Request accepted and dispatched through the supervisor.';
  return 'Request recorded.';
}

/** Studio path: same acceptAndDispatch + syncReply as CLI (MAST-61 / Studio parity). */
export async function dispatchStudioUserTurn(
  agent: Agent,
  text: string,
  memory?: MemoryOpts,
): Promise<AcceptResult | { ok: false; message: string }> {
  const conversationId = threadId(memory);
  if (!conversationId || !text.trim()) {
    return { ok: false, message: 'Studio dispatch requires a thread id and user text.' };
  }
  const workspaceId = await resolveThreadResourceId(agent, conversationId, resourceId(memory));
  const branch = triageUserPrompt(text);
  const envelope = buildUserPromptEnvelope({
    workspaceId,
    conversationId,
    text,
    producerId: 'studio',
    syncReply: true,
    payloadExtra: { supervisorBranch: branch, studioInlineDispatch: true },
  });
  return signalIntakeService.acceptAndDispatch(envelope, { workspaceId, conversationId });
}

/**
 * Studio uses supervisor-orchestrated intake (ledger + dispatch) instead of a parallel raw agent.stream.
 */
export function wrapAssistantSignalIntake(agent: Agent): void {
  const proto = Object.getPrototypeOf(agent) as { generate?: Function; stream?: Function };
  const originalGenerate = agent.generate.bind(agent);
  const originalStream = typeof agent.stream === 'function' ? agent.stream.bind(agent) : undefined;

  async function handleStudioTurn(
    userText: string,
    memory: MemoryOpts | undefined,
    options: unknown,
    fallback: typeof originalGenerate,
  ): Promise<{ text: string }> {
    const quick = tryApplyApprovalUserMessage(userText, threadId(memory));
    if (quick.handled) return { text: quick.message };

    const conversationId = threadId(memory);
    if (!conversationId || !userText.trim()) {
      const response = (await fallback(userText as never, options as never)) as { text?: string | null };
      return { text: response.text?.trim() ?? '' };
    }

    const dispatched = await dispatchStudioUserTurn(agent, userText, memory);
    return { text: studioReplyFromDispatch(dispatched) };
  }

  Object.defineProperty(agent, 'generate', {
    value: async (...args: unknown[]) => {
      const options = args[1];
      const memory = await alignMemoryResource(agent, memoryFromOptions(options));
      const userText = textFromMessages(args[0]);
      return handleStudioTurn(userText, memory, withMemoryOptions(options, memory), originalGenerate);
    },
    writable: true,
    configurable: true,
  });

  if (originalStream && proto.stream) {
    Object.defineProperty(agent, 'stream', {
      value: async (...args: unknown[]) => {
        const options = args[1];
        const memory = await alignMemoryResource(agent, memoryFromOptions(options));
        const userText = textFromMessages(args[0]);
        const { text } = await handleStudioTurn(
          userText,
          memory,
          withMemoryOptions(options, memory),
          originalGenerate,
        );
        return { text } as unknown as Awaited<ReturnType<typeof originalStream>>;
      },
      writable: true,
      configurable: true,
    });
  }
}

function withMemoryOptions(options: unknown, memory?: MemoryOpts): unknown {
  if (!options || typeof options !== 'object' || !memory) return options;
  return { ...(options as Record<string, unknown>), memory };
}