import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assistantDatabasePath } from '../context/scope.ts';
import type { IntakeEnvelope } from './envelope.ts';
import { producerKey } from './envelope.ts';

export type IntakeDispatchStatus = 'accepted' | 'dispatched' | 'failed';

export type IntakeLedgerRow = {
  eventId: string;
  producerKey: string;
  dedupeKey: string;
  envelope: IntakeEnvelope;
  status: IntakeDispatchStatus;
  mastraRecordId?: string;
  deliveryError?: string;
  receivedAt: string;
  updatedAt: string;
};

export interface IntakeLedger {
  accept(envelope: IntakeEnvelope): { inserted: boolean; row: IntakeLedgerRow };
  markDispatched(eventId: string, mastraRecordId?: string): void;
  markFailed(eventId: string, error: string): void;
  listPending(limit?: number): IntakeLedgerRow[];
  getByEventId(eventId: string): IntakeLedgerRow | undefined;
  close?(): void;
}

export class SqliteIntakeLedger implements IntakeLedger {
  private readonly db: DatabaseSync;

  constructor(databasePath = join(dirname(assistantDatabasePath()), 'signal-intake.db')) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS signal_intake (
      event_id TEXT PRIMARY KEY,
      producer_key TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL,
      mastra_record_id TEXT,
      delivery_error TEXT,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(producer_key, dedupe_key)
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS signal_intake_status ON signal_intake(status)`);
  }

  accept(envelope: IntakeEnvelope): { inserted: boolean; row: IntakeLedgerRow } {
    const key = producerKey(envelope.producer);
    const now = new Date().toISOString();
    try {
      this.db.prepare(`INSERT INTO signal_intake
        (event_id, producer_key, dedupe_key, envelope_json, status, received_at, updated_at)
        VALUES (?, ?, ?, ?, 'accepted', ?, ?)`).run(
        envelope.eventId,
        key,
        envelope.dedupeKey,
        JSON.stringify(envelope),
        envelope.receivedAt || now,
        now,
      );
      return { inserted: true, row: this.rowFromEnvelope(envelope, 'accepted', now) };
    } catch (error) {
      const code = (error as { code?: string; errcode?: number }).code;
      const errcode = (error as { errcode?: number }).errcode;
      const isUnique = code === 'SQLITE_CONSTRAINT_UNIQUE' || errcode === 2067;
      if (!isUnique) throw error;
      const existing = this.db.prepare(
        'SELECT * FROM signal_intake WHERE producer_key = ? AND dedupe_key = ?',
      ).get(key, envelope.dedupeKey) as Record<string, unknown> | undefined;
      if (!existing) throw error;
      return { inserted: false, row: this.mapRow(existing) };
    }
  }

  markDispatched(eventId: string, mastraRecordId?: string): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`UPDATE signal_intake SET status = 'dispatched', mastra_record_id = ?, delivery_error = NULL, updated_at = ?
      WHERE event_id = ?`).run(mastraRecordId ?? null, updatedAt, eventId);
  }

  markFailed(eventId: string, error: string): void {
    const updatedAt = new Date().toISOString();
    this.db.prepare(`UPDATE signal_intake SET status = 'failed', delivery_error = ?, updated_at = ? WHERE event_id = ?`)
      .run(error.slice(0, 2000), updatedAt, eventId);
  }

  listPending(limit = 100): IntakeLedgerRow[] {
    const rows = this.db.prepare(
      `SELECT * FROM signal_intake WHERE status = 'accepted' ORDER BY received_at ASC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  getByEventId(eventId: string): IntakeLedgerRow | undefined {
    const row = this.db.prepare('SELECT * FROM signal_intake WHERE event_id = ?').get(eventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  close(): void {
    this.db.close();
  }

  private rowFromEnvelope(envelope: IntakeEnvelope, status: IntakeDispatchStatus, updatedAt: string): IntakeLedgerRow {
    return {
      eventId: envelope.eventId,
      producerKey: producerKey(envelope.producer),
      dedupeKey: envelope.dedupeKey,
      envelope,
      status,
      receivedAt: envelope.receivedAt,
      updatedAt,
    };
  }

  private mapRow(row: Record<string, unknown>): IntakeLedgerRow {
    const envelope = JSON.parse(String(row.envelope_json)) as IntakeEnvelope;
    return {
      eventId: String(row.event_id),
      producerKey: String(row.producer_key),
      dedupeKey: String(row.dedupe_key),
      envelope,
      status: String(row.status) as IntakeDispatchStatus,
      ...(row.mastra_record_id == null ? {} : { mastraRecordId: String(row.mastra_record_id) }),
      ...(row.delivery_error == null ? {} : { deliveryError: String(row.delivery_error) }),
      receivedAt: String(row.received_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export const intakeLedger = new SqliteIntakeLedger();