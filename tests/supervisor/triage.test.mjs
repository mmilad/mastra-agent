import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triageHighConfidenceBranch, triageUserPrompt } from '../../src/supervisor/triage.ts';

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

test('high-confidence triage skips ambiguous delegate+research overlap', () => {
  assert.equal(triageHighConfidenceBranch('Please create notes.txt with hello'), 'delegate');
  assert.equal(triageHighConfidenceBranch('How does signal intake work in the docs?'), 'research');
  assert.equal(triageHighConfidenceBranch('Thanks!'), 'answer');
  assert.equal(
    triageHighConfidenceBranch('Explain signal intake and create hello.txt in the project root'),
    undefined,
  );
});