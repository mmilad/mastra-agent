import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteIntakeLedger } from '../../src/signals/intake-ledger.ts';
import { validateIntakeEnvelope } from '../../src/signals/envelope.ts';
import { SignalIntakeService, buildWorkerEnvelope } from '../../src/signals/intake-service.ts';

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows file locks */ }
}

test('intake ledger dedupes producer keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-intake-'));
  const ledger = new SqliteIntakeLedger(join(dir, 'intake.db'));
  const service = new SignalIntakeService(ledger);
  const workspaceId = 'local-user:project:abc123';
  const envelope = buildWorkerEnvelope({
    workspaceId,
    conversationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    taskId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    worker: 'codex',
    category: 'worker_response',
    dedupeKey: 'worker:task:terminal:completed',
    summary: 'done',
    payload: { status: 'completed' },
  });
  const first = service.accept(envelope, { workspaceId, conversationId: envelope.conversationId });
  const second = service.accept({ ...envelope, dedupeKey: envelope.dedupeKey }, { workspaceId, conversationId: envelope.conversationId });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(first.eventId, second.eventId);
  ledger.close();
  cleanup(dir);
});

test('reconcile retries accepted rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-intake-'));
  const ledger = new SqliteIntakeLedger(join(dir, 'intake.db'));
  const service = new SignalIntakeService(ledger);
  const workspaceId = 'local-user:project:abc123';
  const envelope = buildWorkerEnvelope({
    workspaceId,
    conversationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    taskId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
    worker: 'codex',
    category: 'worker_response',
    dedupeKey: 'worker:task:terminal:failed',
    summary: 'failed',
    payload: { status: 'failed' },
  });
  service.accept(envelope, { workspaceId, conversationId: envelope.conversationId });
  const pending = ledger.listPending();
  assert.equal(pending.length, 1);
  const { processed, failed } = await service.reconcilePending();
  assert.equal(processed + failed, 1);
  assert.equal(ledger.listPending().length, 0);
  ledger.close();
  cleanup(dir);
});

test('rejects invalid envelope schema', () => {
  const result = validateIntakeEnvelope({ schemaVersion: 2 });
  assert.equal(result.ok, false);
});