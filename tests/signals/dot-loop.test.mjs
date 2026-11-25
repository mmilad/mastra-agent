import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteIntakeLedger } from '../../src/signals/intake-ledger.ts';
import { SignalIntakeService, buildWorkerEnvelope } from '../../src/signals/intake-service.ts';
import { registerSignalRuntime } from '../../src/signals/runtime.ts';
import { triageUserPrompt } from '../../src/supervisor/triage.ts';
import { buildUserPromptEnvelope } from '../../src/signals/user-prompt.ts';

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ }
}

test('delegate phrasing triages to delegate branch', () => {
  assert.equal(triageUserPrompt('Please implement a new file src/foo.ts'), 'delegate');
});

test('user prompt enters ledger before mastra dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-loop-'));
  const ledger = new SqliteIntakeLedger(join(dir, 'intake.db'));
  const service = new SignalIntakeService(ledger);
  const workspaceId = 'local-user:project:abc123';
  const conversationId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const envelope = buildUserPromptEnvelope({
    workspaceId,
    conversationId,
    text: 'fix the bug in run.ts',
    producerId: 'test',
    syncReply: false,
  });
  const accepted = service.accept(envelope, { workspaceId, conversationId });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.duplicate, false);
  assert.equal(ledger.listPending().length, 1);
  ledger.close();
  cleanup(dir);
});

test('worker without conversationId is stored unrouted not broadcast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dot-loop-'));
  const ledger = new SqliteIntakeLedger(join(dir, 'intake.db'));
  const service = new SignalIntakeService(ledger);
  const workspaceId = 'local-user:project:abc123';
  const envelope = buildWorkerEnvelope({
    workspaceId,
    taskId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
    worker: 'codex',
    category: 'worker_response',
    dedupeKey: 'worker:orphan:terminal:completed',
    summary: 'done without thread',
    payload: { status: 'completed' },
  });
  const notifications = [];
  registerSignalRuntime({
    getAgent: () => ({
      subscribeToThread: async () => {},
      sendNotificationSignal: async (input) => {
        notifications.push(input);
        return { record: { id: 'n1' } };
      },
    }),
  });
  const result = await service.acceptAndDispatch(envelope, { workspaceId });
  assert.equal(result.ok, true);
  assert.equal(result.unrouted, true);
  assert.equal(notifications.length, 0);
  assert.equal(ledger.listByStatus('unrouted').length, 1);
  const resolved = await service.resolveUnrouted(result.eventId, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
  assert.equal(resolved.ok, true);
  assert.equal(notifications.length, 1);
  const duplicate = await service.acceptAndDispatch(envelope, { workspaceId, conversationId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(notifications.length, 1);
  ledger.close();
  cleanup(dir);
});