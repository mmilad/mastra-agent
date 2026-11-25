import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triageUserPrompt } from '../../src/supervisor/triage.ts';

test('triage selects delegate for file-changing requests', () => {
  assert.equal(triageUserPrompt('Please create a new file notes.txt with hello'), 'delegate');
  assert.equal(triageUserPrompt('fix the bug in src/run.ts'), 'delegate');
});

test('triage selects research for documentation questions', () => {
  assert.equal(triageUserPrompt('How does signal intake work in the docs?'), 'research');
  assert.equal(triageUserPrompt('lookup where mastra signals are documented'), 'research');
});

test('triage selects answer for casual chat', () => {
  assert.equal(triageUserPrompt('Thanks, that helps!'), 'answer');
  assert.equal(triageUserPrompt('What time is it in Berlin?'), 'answer');
});