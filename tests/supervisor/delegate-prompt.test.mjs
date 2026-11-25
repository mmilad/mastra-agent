import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDelegateSupervisorPrompt } from '../../src/supervisor/delegate-prompt.ts';

test('delegate prompt stresses edit vs create', () => {
  const edit = buildDelegateSupervisorPrompt('edit the joke in hello.txt');
  assert.match(edit, /edit\/update/i);
  const create = buildDelegateSupervisorPrompt('create hello.txt with a joke');
  assert.match(create, /create objective/i);
  const cursor = buildDelegateSupervisorPrompt('use cursor to update hello.txt');
  assert.match(cursor, /worker: cursor/i);
});