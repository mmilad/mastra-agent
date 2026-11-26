import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestUserPromptHeuristic } from '../../src/supervisor/prompt-ingest.ts';

test('social utterance is social / general_qa', () => {
  const r = ingestUserPromptHeuristic('Thanks, that helps!');
  assert.ok(r.kinds.includes('social'));
  assert.equal(r.compound, false);
  assert.equal(r.subIntents.length, 1);
});

test('research-only question', () => {
  const r = ingestUserPromptHeuristic('How does signal intake work in the docs?');
  assert.ok(r.kinds.includes('project_research'));
  assert.equal(r.primaryKind, 'project_research');
  assert.equal(r.subIntents[0].suggestedBranch, 'research');
});

test('compound research + task splits sub-intents when clauses differ', () => {
  const r = ingestUserPromptHeuristic(
    'Explain how signal intake is documented and create hello.txt in the project root',
  );
  assert.equal(r.compound, true);
  assert.ok(r.kinds.includes('compound'));
  assert.ok(r.subIntents.length >= 2);
  const branches = new Set(r.subIntents.map((s) => s.suggestedBranch));
  assert.ok(branches.has('research'));
  assert.ok(branches.has('delegate'));
});

test('ops utterance tags ops kind', () => {
  const r = ingestUserPromptHeuristic('approve it');
  assert.ok(r.kinds.includes('ops'));
});