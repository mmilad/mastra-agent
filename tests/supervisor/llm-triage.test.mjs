import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTriageBranchFromLlm } from '../../src/supervisor/llm-triage.ts';
import { triageUserPromptWithLlm } from '../../src/supervisor/llm-triage.ts';

test('parseTriageBranchFromLlm reads JSON branch', () => {
  assert.equal(
    parseTriageBranchFromLlm('{"branch":"delegate","rationale":"user wants a code change"}'),
    'delegate',
  );
  assert.equal(parseTriageBranchFromLlm('Some text {"branch":"research"}'), 'research');
});

test('parseTriageBranchFromLlm reads bare branch word', () => {
  assert.equal(parseTriageBranchFromLlm('branch: answer'), 'answer');
});

test('triageUserPromptWithLlm uses heuristic when forced', async () => {
  const previous = process.env.SUPERVISOR_TRIAGE_HEURISTIC_ONLY;
  process.env.SUPERVISOR_TRIAGE_HEURISTIC_ONLY = '1';
  try {
    const result = await triageUserPromptWithLlm('Please implement a new file foo.ts');
    assert.equal(result.source, 'heuristic');
    assert.equal(result.branch, 'delegate');
  } finally {
    if (previous === undefined) delete process.env.SUPERVISOR_TRIAGE_HEURISTIC_ONLY;
    else process.env.SUPERVISOR_TRIAGE_HEURISTIC_ONLY = previous;
  }
});