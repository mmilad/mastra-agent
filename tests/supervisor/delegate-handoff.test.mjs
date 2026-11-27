import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDelegateHandoffBrief,
  formatDelegateHandoffForAssistant,
} from '../../src/supervisor/delegate-handoff.ts';
import { readDelegateHandoffBrief } from '../../src/supervisor/execute.ts';

test('handoff brief infers worker and create criteria', () => {
  const brief = buildDelegateHandoffBrief('create hello.txt with a joke');
  assert.equal(brief.worker, 'codex');
  assert.ok(brief.acceptanceCriteria.some((c) => /New artifact/i.test(c)));
});

test('handoff brief prefers edit constraints', () => {
  const brief = buildDelegateHandoffBrief('edit the joke in hello.txt');
  assert.ok(brief.constraints.some((c) => /editing existing/i.test(c)));
});

test('handoff brief honors cursor in text', () => {
  const brief = buildDelegateHandoffBrief('use cursor to update hello.txt');
  assert.equal(brief.worker, 'cursor');
});

test('format includes JSON criteria for delegate-task', () => {
  const text = formatDelegateHandoffForAssistant(buildDelegateHandoffBrief('fix src/run.ts'));
  assert.match(text, /acceptanceCriteria:/);
  assert.match(text, /delegate-task exactly once/);
});

test('readDelegateHandoffBrief reads step output', () => {
  const brief = buildDelegateHandoffBrief('fix src/run.ts');
  const wrapped = readDelegateHandoffBrief({
    steps: { 'assemble-delegate-brief': { output: brief } },
  });
  assert.equal(wrapped?.objective, brief.objective);
});