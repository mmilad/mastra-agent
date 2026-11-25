/**
 * Deterministic acceptance scenarios for the MVP vertical slice (MAST-40).
 * These mirror the policy/context/tools suites in one place for pilot evidence.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteTaskStore } from '../../src/context/task-store.ts';
import { TaskRegistry } from '../../src/mastra/tools/task-registry.ts';
import { SqliteIntakeLedger } from '../../src/signals/intake-ledger.ts';
import { validateIntakeEnvelope } from '../../src/signals/envelope.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const brief = { objective: 'Acceptance probe', constraints: [], acceptanceCriteria: [], contextReferences: [] };

test('interrupted active task is visible after restart and not replayed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-task-'));
  const db = join(dir, 'tasks.db');
  t.after(() => {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows file locks */ }
  });
  const store = new SqliteTaskStore(db);
  const first = new TaskRegistry(() => new Promise(() => {}), store);
  const started = (await first.start(dir, brief)).task;
  await new Promise((resolve) => setTimeout(resolve, 200));
  store.close();
  const second = new TaskRegistry(undefined, new SqliteTaskStore(db));
  assert.equal(second.get(started.taskId, dir)?.status, 'interrupted');
});

test('signal intake dedupe prevents duplicate dispatch records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-intake-'));
  const ledger = new SqliteIntakeLedger(join(dir, 'intake.db'));
  const now = new Date().toISOString();
  const envelope = {
    schemaVersion: 1,
    eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10',
    category: 'worker_response',
    workspaceId: 'local-user:project:deadbeef',
    conversationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    occurredAt: now,
    receivedAt: now,
    producer: { kind: 'worker', id: 'codex' },
    correlationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    dedupeKey: 'worker:acceptance:terminal',
    payload: { summary: 'done', kind: 'task-result', status: 'completed' },
  };
  assert.equal(validateIntakeEnvelope(envelope).ok, true);
  const first = ledger.accept(envelope);
  const second = ledger.accept({ ...envelope, eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13' });
  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(first.row.eventId, second.row.eventId);
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});