import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveThreadResourceIdFromContext } from '../../src/context/thread-resource.ts';

test('resolveThreadResourceIdFromContext does not throw when tool agent lacks getMemory', async () => {
  const resource = await resolveThreadResourceIdFromContext(
    { agent: { threadId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' } },
    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    'assistant',
  );
  assert.equal(resource, 'assistant');
});