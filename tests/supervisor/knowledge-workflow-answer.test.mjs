import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readKnowledgeWorkflowAnswer } from '../../src/supervisor/execute.ts';

test('readKnowledgeWorkflowAnswer reads top-level result', () => {
  assert.equal(
    readKnowledgeWorkflowAnswer({ result: { answer: '  from readme  ' } }),
  'from readme',
  );
});

test('readKnowledgeWorkflowAnswer reads step output', () => {
  assert.equal(
    readKnowledgeWorkflowAnswer({
      steps: { 'answer-from-knowledge': { output: { answer: 'step body' } } },
    }),
    'step body',
  );
});

test('readKnowledgeWorkflowAnswer returns undefined when empty', () => {
  assert.equal(readKnowledgeWorkflowAnswer({ result: { answer: '   ' } }), undefined);
  assert.equal(readKnowledgeWorkflowAnswer({}), undefined);
});