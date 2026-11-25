import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assistant } from '../../src/mastra/agents/assistant.ts';

test('conversation history is token-budgeted and compact work memory is bounded per thread', async () => {
  const memory = await assistant.getMemory();
  assert.ok(memory);
  const config = memory.getMergedThreadConfig();
  assert.deepEqual(config.messageHistory, { maxTokens: 6_000, atMaxRemoveTokens: 1_500 });
  assert.equal(config.lastMessages, 20);
  assert.equal(config.workingMemory?.scope, 'thread');
  assert.equal(config.workingMemory?.enabled, true);

  const schema = config.workingMemory?.schema;
  assert.ok(schema);
  assert.equal(schema.safeParse({
    objective: 'Ship the feature',
    constraints: ['Keep the API stable'],
    unresolvedWork: ['Add migration coverage'],
    decisions: ['Use SQLite'],
    compactSummary: 'The active objective and pending migration test.',
  }).success, true);
  assert.equal(schema.safeParse({
    objective: 'x'.repeat(501),
    constraints: [], unresolvedWork: [], decisions: [], compactSummary: '',
  }).success, false);
  assert.equal(schema.safeParse({
    objective: 'bounded',
    constraints: Array.from({ length: 13 }, () => 'x'),
    unresolvedWork: [], decisions: [], compactSummary: '',
  }).success, false);

  const defaults = await assistant.getDefaultOptions();
  assert.equal(defaults.maxSteps, 12);
  assert.equal(defaults.modelSettings?.maxOutputTokens, 4_096);
  const generateDefaults = await assistant.getDefaultGenerateOptionsLegacy();
  const streamDefaults = await assistant.getDefaultStreamOptionsLegacy();
  assert.equal(generateDefaults.maxTokens, 4_096);
  assert.equal(streamDefaults.maxTokens, 4_096);
});
