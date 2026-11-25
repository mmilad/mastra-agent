import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistantDefaultMaxSteps } from '../../src/mastra/agents/generate-options.ts';

test('assistant allows multiple steps after tool calls', () => {
  assert.ok(assistantDefaultMaxSteps >= 5);
});