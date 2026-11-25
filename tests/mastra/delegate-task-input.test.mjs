import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delegateTaskInputSchema } from '../../src/mastra/tools/managed-tasks.ts';

test('delegate-task accepts string constraints and splits into an array', () => {
  const parsed = delegateTaskInputSchema.parse({
    objective: 'Create hello.txt with a joke',
    constraints: '[Path: project root, Filename: hello.txt, Content: a joke]',
    acceptanceCriteria: 'hello.txt exists; contains a joke',
  });
  assert.equal(parsed.constraints.length >= 1, true);
  assert.match(parsed.constraints.join(' '), /hello\.txt/);
  assert.ok(Array.isArray(parsed.acceptanceCriteria));
});