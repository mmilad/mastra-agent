import { projectResourceId, findWorkspaceRoot } from '../context/scope.ts';
import { buildUserPromptEnvelope } from './user-prompt.ts';
import { signalIntakeService } from './intake-service.ts';

export type ChatApiBody = {
  text?: string;
  threadId?: string;
  sync?: boolean;
};

export async function handleChatApiRequest(request: Request): Promise<Response> {
  const token = process.env.SIGNAL_INTAKE_TOKEN?.trim();
  if (token) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${token}`) {
      return Response.json({ error: 'Unauthorized.' }, { status: 401 });
    }
  }

  let body: ChatApiBody;
  try {
    body = (await request.json()) as ChatApiBody;
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return Response.json({ error: 'text is required.' }, { status: 400 });

  const conversationId = body.threadId?.trim() || request.headers.get('x-conversation-id')?.trim();
  if (!conversationId) {
    return Response.json({ error: 'threadId or x-conversation-id header is required.' }, { status: 400 });
  }

  const workspaceId = projectResourceId(findWorkspaceRoot());
  const syncReply = body.sync !== false;
  const envelope = buildUserPromptEnvelope({
    workspaceId,
    conversationId,
    text,
    producerId: 'http-chat',
    syncReply,
  });

  const result = await signalIntakeService.acceptAndDispatch(envelope, { workspaceId, conversationId });
  if (!result.ok) return Response.json({ error: result.message }, { status: 400 });

  return Response.json(
    {
      eventId: result.eventId,
      duplicate: result.duplicate,
      dispatched: result.dispatched,
      branch: result.branch,
      responseText: result.responseText,
    },
    { status: syncReply ? 200 : 202 },
  );
}

export const chatApiRoute = {
  method: 'POST' as const,
  path: '/v1/chat',
  handler: async (c: { req: { raw: Request } }) => handleChatApiRequest(c.req.raw),
};