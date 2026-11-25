import { newEventId, type IntakeEnvelope } from './envelope.ts';

export function buildUserPromptEnvelope(input: {
  workspaceId: string;
  conversationId: string;
  text: string;
  producerId: string;
  eventId?: string;
  dedupeKey?: string;
  syncReply?: boolean;
  payloadExtra?: Record<string, unknown>;
}): IntakeEnvelope {
  const now = new Date().toISOString();
  const eventId = input.eventId ?? newEventId();
  const dedupeKey = input.dedupeKey ?? `user:${input.producerId}:${eventId}`;
  return {
    schemaVersion: 1,
    eventId,
    category: 'user_prompt',
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    occurredAt: now,
    receivedAt: now,
    producer: { kind: 'user', id: input.producerId },
    dedupeKey,
    payload: {
      text: input.text,
      ...(input.syncReply ? { syncReply: true } : {}),
      ...(input.payloadExtra ?? {}),
    },
  };
}