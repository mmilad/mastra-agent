import { projectResourceId, findWorkspaceRoot } from '../context/scope.ts';
import { signalIntakeService } from './intake-service.ts';
import { MAX_PAYLOAD_BYTES } from './envelope.ts';

const intakeToken = () => process.env.SIGNAL_INTAKE_TOKEN?.trim();

export async function handleSignalIntakeRequest(request: Request): Promise<Response> {
  const token = intakeToken();
  if (!token) {
    return Response.json({ error: 'Signal intake is disabled.' }, { status: 503 });
  }
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${token}`) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_PAYLOAD_BYTES + 4096) {
    return Response.json({ error: 'Body too large.' }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON.' }, { status: 400 });
  }

  const workspaceId = projectResourceId(findWorkspaceRoot());
  const conversationHeader = request.headers.get('x-conversation-id') ?? undefined;
  const result = await signalIntakeService.acceptAndDispatch(body, { workspaceId, conversationId: conversationHeader });

  if (!result.ok) return Response.json({ error: result.message }, { status: 400 });
  return Response.json(
    { eventId: result.eventId, duplicate: result.duplicate, dispatched: result.dispatched },
    { status: result.duplicate ? 200 : 202 },
  );
}

/** Mastra-compatible route wrapper for local HTTP intake (MAST-58 / MAST-60). */
export const signalIntakeApiRoute = {
  method: 'POST' as const,
  path: '/signal-intake',
  handler: async (c: { req: { raw: Request } }) => handleSignalIntakeRequest(c.req.raw),
};