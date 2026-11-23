import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commentOnPlanTicket,
  createPlanTask,
  plantoolLookup,
  updatePlanTicket,
} from '../../src/mastra/tools/plantool.ts';

const projectRoot = process.cwd();
const context = (text) => ({ agent: { messages: [{ role: 'user', content: text }] } });

test('read-only lookup returns the active project and requested ticket', async () => {
  const result = await plantoolLookup.execute({ operation: 'ticket', id: 'MAST-36', limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.projectRoot, projectRoot);
  const ticket = JSON.parse(result.resultJson);
  assert.equal(ticket.key, 'MAST-36');
});

test('lookup surface only exposes read operations', () => {
  assert.deepEqual(plantoolLookup.inputSchema.shape.operation.options, [
    'next', 'tree', 'ticket', 'context', 'search', 'goals', 'plans', 'decisions',
  ]);
});

test('create reuses an exact title and refuses negated user requests', async () => {
  const input = {
    title: 'Integrate plantool through structured CLI operations',
    description: 'A duplicate attempt that must not add another task.',
    parentId: 'MAST-25',
    why: 'Exercise exact-title deduplication.',
    acceptanceCriteria: ['Do not create a duplicate.'],
  };
  const duplicate = await createPlanTask.execute(input, context('Create this task under MAST-25'));
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.created, false);
  assert.match(duplicate.message, /already exists/);

  const negated = await createPlanTask.execute(input, context("Don't create this task under MAST-25"));
  assert.equal(negated.ok, false);
  assert.equal(negated.created, false);
});

test('updates preserve person-owned decisions and require the exact target reference', async () => {
  const decision = await updatePlanTicket.execute(
    { ticketId: 'MAST-2', title: 'Altered decision title' },
    context('Update MAST-2 with a test title'),
  );
  assert.equal(decision.ok, false);
  assert.match(decision.message, /Person-owned decisions/);

  const partialId = await updatePlanTicket.execute(
    { ticketId: 'MAST-3', title: 'Altered option title' },
    context('Update MAST-36 with a test title'),
  );
  assert.equal(partialId.ok, false);
  assert.match(partialId.message, /explicitly request/);
});

test('plan comments require explicit latest-user authorization', async () => {
  const result = await commentOnPlanTicket.execute(
    { ticketId: 'MAST-36', comment: 'A test note that must not be written.' },
    context('We discussed MAST-36 earlier.'),
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /explicit user request/);
});
