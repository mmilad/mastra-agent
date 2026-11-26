import type { SendNotificationSignalInput } from '@mastra/core/notifications';
import type { IntakeEnvelope } from './envelope.ts';
import { getSignalMastra } from './runtime.ts';
import { runSupervisorRouting } from '../mastra/workflows/supervisor-routing.ts';
import { ensureThreadSubscribed } from './thread-subscribe.ts';
import { resolveThreadResourceId } from '../context/thread-resource.ts';
import { generateWithCompletion } from '../mastra/agents/generate-options.ts';

const TERMINAL_WORKER_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const workerFollowupEnabled = process.env.WORKER_FOLLOWUP_GENERATE !== 'false';

function notificationInput(envelope: IntakeEnvelope): SendNotificationSignalInput | undefined {
  const { category, payload, correlationId, dedupeKey } = envelope;
  if (category !== 'worker_response' && category !== 'worker_progress' && category !== 'ci_run' && category !== 'external_event') {
    return undefined;
  }
  const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 2000) : 'External event';
  const kind = typeof payload.kind === 'string' ? payload.kind : category;
  const priority = payload.priority === 'high' || payload.priority === 'urgent' ? payload.priority : 'medium';
  const coalesceKey = category === 'worker_progress' && typeof payload.coalesceKey === 'string'
    ? payload.coalesceKey
    : undefined;
  return {
    source: envelope.producer.kind === 'worker' ? 'worker' : envelope.producer.kind,
    kind,
    summary,
    priority,
    payload,
    dedupeKey,
    ...(coalesceKey ? { coalesceKey } : {}),
    attributes: {
      ...(correlationId ? { correlationId } : {}),
      category,
      eventId: envelope.eventId,
    },
  };
}

export type DispatchResult =
  | { ok: true; recordId?: string; branch?: string; responseText?: string; routing?: string }
  | { ok: false; error: string };

export async function dispatchEnvelope(envelope: IntakeEnvelope): Promise<DispatchResult> {
  const mastra = getSignalMastra();
  if (!mastra) return { ok: false, error: 'Mastra runtime is not registered.' };
  const agent = mastra.getAgent('assistant');
  if (!agent) return { ok: false, error: 'Assistant agent is not configured.' };

  if (envelope.category === 'user_prompt') {
    if (!envelope.conversationId) return { ok: false, error: 'user_prompt requires conversationId.' };
    const text = typeof envelope.payload.text === 'string' ? envelope.payload.text : '';
    if (!text.trim()) return { ok: false, error: 'user_prompt payload.text is required.' };
    const syncReply = envelope.payload.syncReply === true;
    try {
      const resourceId = await resolveThreadResourceId(agent, envelope.conversationId, envelope.workspaceId);
      await ensureThreadSubscribed(agent, { resourceId, threadId: envelope.conversationId });
      const routed = await runSupervisorRouting(mastra, {
        text,
        resourceId,
        threadId: envelope.conversationId,
        syncReply,
      });
      const routingNote = routed.routing ? JSON.stringify({ branch: routed.branch, ...routed.routing }) : undefined;
      return {
        ok: true,
        branch: routed.branch,
        ...(routed.responseText ? { responseText: routed.responseText } : {}),
        ...(routingNote ? { routing: routingNote } : {}),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const input = notificationInput(envelope);
  if (!input) return { ok: false, error: `Unsupported category ${envelope.category}.` };
  if (!envelope.conversationId) {
    return { ok: false, error: 'Notification intake requires conversationId for thread routing.' };
  }

  try {
    const resourceId = await resolveThreadResourceId(agent, envelope.conversationId, envelope.workspaceId);
    await ensureThreadSubscribed(agent, { resourceId, threadId: envelope.conversationId });
    const result = await agent.sendNotificationSignal(input, {
      resourceId,
      threadId: envelope.conversationId,
    });
    const recordId = Array.isArray(result) ? result[0]?.record?.id : result.record?.id;

    const workerStatus = typeof envelope.payload.status === 'string' ? envelope.payload.status : '';
    if (
      workerFollowupEnabled &&
      envelope.category === 'worker_response' &&
      TERMINAL_WORKER_STATUSES.has(workerStatus)
    ) {
      const summary = typeof envelope.payload.summary === 'string' ? envelope.payload.summary : input.summary;
      try {
        await generateWithCompletion(
          agent,
          `[Worker task update — summarize for the user in plain language; do not start a new task]\n${summary}`,
          { memory: { thread: envelope.conversationId, resource: resourceId } },
        );
      } catch (error) {
        console.warn(
          '[signals] worker follow-up generate failed:',
          error instanceof Error ? error.message : error,
        );
      }
    }

    return { ok: true, ...(recordId ? { recordId } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}