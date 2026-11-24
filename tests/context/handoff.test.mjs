import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHandoffPackage, handoffPackageLength } from '../../src/context/handoff.ts';
import { projectScopeId } from '../../src/context/scope.ts';

const brief = { objective: 'Do work', constraints: ['Keep API stable'], acceptanceCriteria: ['All done'], contextReferences: [] };
function fact(root, id, updatedAt, value = 'value') {
  return { id, scope: 'project', projectId: projectScopeId(root), kind: 'fact', key: id, value, revision: 1, updatedAt, status: 'active' };
}

test('handoff stays within budget and drops oldest facts first', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  try {
    const records = [fact(root, 'old', '2020-01-01', 'x'.repeat(400)), fact(root, 'new', '2025-01-01', 'y'.repeat(400))];
    const handoff = buildHandoffPackage(brief, root, records, 360);
    assert.ok(handoffPackageLength(handoff) <= 360);
    assert.equal(handoff.omittedFactCount, 2);
    assert.deepEqual(handoff.facts, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('required brief survives a small budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  try {
    const handoff = buildHandoffPackage(brief, root, [fact(root, 'x', '2020', 'z'.repeat(100))], 1);
    assert.deepEqual(handoff.constraints, brief.constraints);
    assert.deepEqual(handoff.acceptanceCriteria, brief.acceptanceCriteria);
    assert.equal(handoff.facts.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('excludes facts from another project and includes IDs and revisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-'));
  const other = mkdtempSync(join(tmpdir(), 'handoff-other-'));
  try {
    const handoff = buildHandoffPackage(brief, root, [fact(root, 'local-id', '2025'), { ...fact(other, 'foreign-id', '2025') }]);
    assert.equal(handoff.facts.length, 1);
    assert.equal(handoff.facts[0].id, 'local-id');
    assert.equal(handoff.facts[0].revision, 1);
    assert.equal(handoff.omittedFactCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
