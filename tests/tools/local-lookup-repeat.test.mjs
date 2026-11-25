import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localProjectLookup } from '../../src/mastra/tools/local-lookup.ts';

test('duplicate project search within 30s returns a visible error', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lookup-repeat-'));
  t.after(() => {
    delete process.env.ASSISTANT_PROJECT_ROOT;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows file locks */ }
  });
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'needle.txt'), 'needle here');
  process.env.ASSISTANT_PROJECT_ROOT = root;
  const context = { agent: { threadId: 'thread-repeat-test' } };
  const first = await localProjectLookup.execute({ operation: 'search', query: 'needle' }, context);
  const second = await localProjectLookup.execute({ operation: 'search', query: 'needle' }, context);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.match(second.message, /already run/);
});

test('local lookup always returns a non-empty message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lookup-msg-'));
  mkdirSync(join(root, '.git'));
  process.env.ASSISTANT_PROJECT_ROOT = root;
  try {
    const result = await localProjectLookup.execute({ operation: 'search', query: 'ab' });
    assert.ok(result.message.length > 0);
  } finally {
    delete process.env.ASSISTANT_PROJECT_ROOT;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows file locks */ }
  }
});