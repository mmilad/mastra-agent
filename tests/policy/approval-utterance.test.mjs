import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isInformalApproval, isInformalDenial } from '../../src/policy/approval-utterance.ts';

test('informal approval phrases', () => {
  assert.equal(isInformalApproval('approve it'), true);
  assert.equal(isInformalApproval('Approve it.'), true);
  assert.equal(isInformalApproval('go ahead'), true);
  assert.equal(isInformalApproval('yes please'), true);
  assert.equal(isInformalApproval('create hello.txt'), false);
});

test('informal denial phrases', () => {
  assert.equal(isInformalDenial('deny it'), true);
  assert.equal(isInformalDenial('no'), true);
  assert.equal(isInformalDenial('approve it'), false);
});