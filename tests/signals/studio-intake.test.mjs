import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteIntakeLedger } from '../../src/signals/intake-ledger.ts';
import { SignalIntakeService } from '../../src/signals/intake-service.ts';

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows */ }
}

test('studio producer envelope stores supervisor branch metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-intake-'));
  const ledger = new SqliteIntakeLedger(join(dir, 'intake.db'));
  const service = new SignalIntakeService(ledger);
  const workspaceId = 'local-user:project:abc123';
  const conversationId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const result = service.accept(
    {
      schemaVersion: 1,
      eventId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
      category: 'user_prompt',
      workspaceId,
      conversationId,
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      producer: { kind: 'user', id: 'studio' },
      dedupeKey: 'user:studio:turn:1',
      payload: { text: 'fix run.ts', supervisorBranch: 'delegate', studioInlineDispatch: true, syncReply: true },
    },
    { workspaceId, conversationId },
  );
  assert.equal(result.ok, true);
  const row = ledger.listPending()[0];
  assert.equal(row.envelope.payload.supervisorBranch, 'delegate');
  ledger.close();
  cleanup(dir);
});