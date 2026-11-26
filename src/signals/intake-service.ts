import { validateIntakeEnvelope, type IntakeEnvelope, newEventId } from './envelope.ts';
import type { IntakeLedger } from './intake-ledger.ts';
import { intakeLedger, intakeRequiresConversation } from './intake-ledger.ts';
import { dispatchEnvelope } from './dispatch.ts';

export type AcceptResult =
  | {
      ok: true;
      duplicate: boolean;
      eventId: string;
      dispatched: boolean;
      branch?: string;
      responseText?: string;
      unrouted?: boolean;
    }
  | { ok: false; message: string };

export class SignalIntakeService {
  private readonly ledger: IntakeLedger;
  private readonly dispatchInFlight = new Set<string>();

  constructor(ledger: IntakeLedger = intakeLedger) {
    this.ledger = ledger;
  }

  accept(raw: unknown, trusted: { workspaceId: string; conversationId?: string }): AcceptResult {
    const receivedAt = new Date().toISOString();
    const base = typeof raw === 'object' && raw !== null ? { ...(raw as Record<string, unknown>) } : raw;
    const withTrust = typeof base === 'object' && base !== null
      ? {
          ...base,
          workspaceId: trusted.workspaceId,
          ...(trusted.conversationId ? { conversationId: trusted.conversationId } : {}),
          receivedAt: (base as { receivedAt?: string }).receivedAt ?? receivedAt,
          eventId: (base as { eventId?: string }).eventId ?? newEventId(),
        }
      : base;

    const validated = validateIntakeEnvelope(withTrust);
    if (!validated.ok) return { ok: false, message: validated.message };

    const envelope = validated.envelope;
    if (intakeRequiresConversation(envelope) && !envelope.conversationId) {
      const { inserted, row } = this.ledger.acceptUnrouted(
        envelope,
        'Missing conversationId. Use intake resolve to bind a thread before dispatch.',
      );
      return {
        ok: true,
        duplicate: !inserted,
        eventId: row.eventId,
        dispatched: false,
        unrouted: true,
      };
    }

    const { inserted, row } = this.ledger.accept(envelope);
    if (!inserted) {
      return {
        ok: true,
        duplicate: true,
        eventId: row.eventId,
        dispatched: row.status === 'dispatched',
        ...(row.status === 'unrouted' ? { unrouted: true } : {}),
      };
    }
    return { ok: true, duplicate: false, eventId: row.eventId, dispatched: false };
  }

  async acceptAndDispatch(raw: unknown, trusted: { workspaceId: string; conversationId?: string }): Promise<AcceptResult> {
    const accepted = this.accept(raw, trusted);
    if (!accepted.ok) return accepted;
    if (accepted.unrouted) return accepted;
    if (accepted.duplicate && accepted.dispatched) return accepted;
    const dispatched = await this.dispatchEvent(accepted.eventId);
    if (!dispatched.ok) return { ok: false, message: dispatched.error };
    return {
      ...accepted,
      dispatched: true,
      ...(dispatched.branch ? { branch: dispatched.branch } : {}),
      ...(dispatched.responseText ? { responseText: dispatched.responseText } : {}),
    };
  }

  async dispatchEvent(
    eventId: string,
  ): Promise<
    | { ok: true; recordId?: string; branch?: string; responseText?: string; routing?: string }
    | { ok: false; error: string }
  > {
    const row = this.ledger.getByEventId(eventId);
    if (!row) return { ok: false, error: `Unknown intake event ${eventId}.` };
    if (row.status === 'dispatched') {
      return { ok: true, ...(row.mastraRecordId ? { recordId: row.mastraRecordId } : {}) };
    }
    if (this.dispatchInFlight.has(eventId)) {
      return { ok: true };
    }

    this.dispatchInFlight.add(eventId);
    try {
      const result = await dispatchEnvelope(row.envelope);
      if (!result.ok) {
        this.ledger.markFailed(eventId, result.error);
        return result;
      }
      this.ledger.markDispatched(eventId, result.recordId, result.routing);
      return {
        ok: true,
        ...(result.recordId ? { recordId: result.recordId } : {}),
        ...(result.branch ? { branch: result.branch } : {}),
        ...(result.responseText ? { responseText: result.responseText } : {}),
      };
    } finally {
      this.dispatchInFlight.delete(eventId);
    }
  }

  async reconcilePending(limit = 50): Promise<{ processed: number; failed: number }> {
    const pending = this.ledger.listPending(limit);
    let processed = 0;
    let failed = 0;
    for (const row of pending) {
      if (
        row.envelope.category === 'user_prompt' &&
        row.envelope.payload.studioInlineDispatch === true &&
        this.dispatchInFlight.has(row.eventId)
      ) {
        continue;
      }
      const result = await this.dispatchEvent(row.eventId);
      if (result.ok) processed += 1;
      else failed += 1;
    }
    return { processed, failed };
  }

  async resolveUnrouted(eventId: string, conversationId: string): Promise<AcceptResult> {
    const row = this.ledger.resolveConversation(eventId, conversationId);
    if (!row) return { ok: false, message: `Event ${eventId} is not unrouted or does not exist.` };
    const dispatched = await this.dispatchEvent(eventId);
    if (!dispatched.ok) return { ok: false, message: dispatched.error };
    return {
      ok: true,
      duplicate: false,
      eventId,
      dispatched: true,
      ...(dispatched.branch ? { branch: dispatched.branch } : {}),
      ...(dispatched.responseText ? { responseText: dispatched.responseText } : {}),
    };
  }

  listIntakeRows(status: 'accepted' | 'failed' | 'unrouted' | 'dispatched', limit = 50) {
    return this.ledger.listByStatus(status, limit);
  }
}

export function buildWorkerEnvelope(input: {
  workspaceId: string;
  conversationId?: string;
  taskId: string;
  worker: string;
  category: 'worker_response' | 'worker_progress';
  dedupeKey: string;
  summary: string;
  payload: Record<string, unknown>;
  correlationId?: string;
}): IntakeEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    eventId: newEventId(),
    category: input.category,
    workspaceId: input.workspaceId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    occurredAt: now,
    receivedAt: now,
    producer: { kind: 'worker', id: input.worker },
    ...(input.correlationId ? { correlationId: input.correlationId } : { correlationId: input.taskId }),
    dedupeKey: input.dedupeKey,
    payload: { ...input.payload, summary: input.summary, kind: input.payload.kind ?? input.category },
  };
}

export const signalIntakeService = new SignalIntakeService();