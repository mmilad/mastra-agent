import { createHmac, timingSafeEqual } from 'node:crypto';
import { newEventId } from './envelope.ts';
import type { IntakeEnvelope } from './envelope.ts';
import { signalIntakeService } from './intake-service.ts';
import { resolveSubscription } from './subscriptions.ts';

function verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

export function buildCiRunEnvelope(input: {
  workspaceId: string;
  conversationId?: string;
  repository: string;
  event: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}): IntakeEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    eventId: newEventId(),
    category: 'ci_run',
    workspaceId: input.workspaceId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    occurredAt: now,
    receivedAt: now,
    producer: { kind: 'github', id: input.repository },
    correlationId: input.deliveryId,
    dedupeKey: `github:${input.deliveryId}`,
    payload: {
      event: input.event,
      repository: input.repository,
      summary: `GitHub ${input.event} on ${input.repository}`,
      ...input.payload,
    },
  };
}

export async function handleGithubCiWebhook(request: Request): Promise<Response> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: 'GitHub webhook intake is disabled.' }, { status: 503 });
  }
  const rawBody = await request.text();
  const signature = request.headers.get('x-hub-signature-256');
  if (!verifyGithubSignature(secret, rawBody, signature)) {
    return Response.json({ error: 'Invalid signature.' }, { status: 401 });
  }
  const event = request.headers.get('x-github-event') ?? 'unknown';
  const deliveryId = request.headers.get('x-github-delivery') ?? newEventId();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  }
  const repository =
    typeof payload.repository === 'object' && payload.repository && 'full_name' in payload.repository
      ? String((payload.repository as { full_name: unknown }).full_name)
      : process.env.GITHUB_DEFAULT_REPO?.trim();
  if (!repository) {
    return Response.json({ error: 'Repository could not be resolved.' }, { status: 400 });
  }
  const sub = resolveSubscription('github', repository);
  if (!sub) {
    return Response.json({ error: 'No subscription for repository.' }, { status: 403 });
  }
  const envelope = buildCiRunEnvelope({
    workspaceId: sub.workspaceId,
    conversationId: sub.conversationId,
    repository,
    event,
    deliveryId,
    payload: { githubEvent: event, action: payload.action, ref: payload.ref },
  });
  const result = await signalIntakeService.acceptAndDispatch(envelope, {
    workspaceId: sub.workspaceId,
    ...(sub.conversationId ? { conversationId: sub.conversationId } : {}),
  });
  if (!result.ok) return Response.json({ error: result.message }, { status: 400 });
  return Response.json(
    { eventId: result.eventId, duplicate: result.duplicate, unrouted: result.unrouted ?? false },
    { status: result.duplicate ? 200 : 202 },
  );
}

export const githubCiWebhookRoute = {
  method: 'POST' as const,
  path: '/webhooks/github',
  handler: async (c: { req: { raw: Request } }) => handleGithubCiWebhook(c.req.raw),
};