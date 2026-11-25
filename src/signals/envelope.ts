import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const INTAKE_SCHEMA_VERSION = 1 as const;
export const MAX_PAYLOAD_BYTES = 32_768;

const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid ISO timestamp');

const producerSchema = z.object({
  kind: z.enum(['user', 'worker', 'github', 'system']),
  id: z.string().min(1).max(200),
});

const categorySchema = z.enum(['user_prompt', 'worker_response', 'worker_progress', 'ci_run', 'external_event']);

export const intakeEnvelopeSchema = z.object({
  schemaVersion: z.literal(INTAKE_SCHEMA_VERSION),
  eventId: z.string().uuid(),
  category: categorySchema,
  workspaceId: z.string().min(8).max(128),
  conversationId: z.string().uuid().optional(),
  occurredAt: isoTimestamp,
  receivedAt: isoTimestamp,
  producer: producerSchema,
  correlationId: z.string().uuid().optional(),
  sequence: z.number().int().nonnegative().optional(),
  dedupeKey: z.string().min(1).max(300),
  payload: z.record(z.string(), z.unknown()),
});

export type IntakeEnvelope = z.infer<typeof intakeEnvelopeSchema>;

export type IntakeRejectReason = 'schema' | 'size' | 'routing';

export function validateIntakeEnvelope(input: unknown):
  | { ok: true; envelope: IntakeEnvelope }
  | { ok: false; reason: IntakeRejectReason; message: string } {
  const parsed = intakeEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'schema', message: parsed.error.message.slice(0, 500) };
  }
  const envelope = parsed.data;
  const payloadSize = Buffer.byteLength(JSON.stringify(envelope.payload), 'utf8');
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'size', message: `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes.` };
  }
  if (envelope.category === 'user_prompt' && !envelope.conversationId) {
    return { ok: false, reason: 'routing', message: 'user_prompt requires conversationId.' };
  }
  return { ok: true, envelope };
}

export function producerKey(producer: IntakeEnvelope['producer']): string {
  return `${producer.kind}:${producer.id}`;
}

export function newEventId(): string {
  return randomUUID();
}