import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectResourceId, projectScopeId } from '../../src/context/scope.ts';
import { saveSelectedThread, selectConversation } from '../../src/context/conversations.ts';

test('different projects get distinct resource and scope identifiers', () => {
  const base = mkdtempSync(join(tmpdir(), 'mastra-scope-'));
  const projectA = join(base, 'alpha');
  const projectB = join(base, 'beta');
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(join(projectA, '.git'), '');
  writeFileSync(join(projectB, '.git'), '');

  const scopeA = projectScopeId(projectA);
  const scopeB = projectScopeId(projectB);
  const resourceA = projectResourceId(projectA);
  const resourceB = projectResourceId(projectB);

  assert.notEqual(scopeA, scopeB);
  assert.notEqual(resourceA, resourceB);
  rmSync(base, { recursive: true, force: true });
});

test('session pointer and thread selection reject another project conversation', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mastra-switch-'));
  const projectA = join(base, 'alpha');
  const projectB = join(base, 'beta');
  mkdirSync(join(projectA, '.mastra'), { recursive: true });
  mkdirSync(join(projectB, '.mastra'), { recursive: true });
  writeFileSync(join(projectA, '.git'), '');
  writeFileSync(join(projectB, '.git'), '');

  const foreignThread = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const foreignResource = projectResourceId(projectA);
  saveSelectedThread(projectB, foreignThread);
  writeFileSync(join(projectB, '.mastra', 'terminal-session.json'), JSON.stringify({ threadId: foreignThread, resourceId: foreignResource }) + '\n');

  const memory = {
    async getThreadById({ threadId }) {
      if (threadId === foreignThread) return { id: foreignThread, resourceId: foreignResource };
      return null;
    },
    async saveThread() {},
  };

  const threadB = await selectConversation(memory, projectB, { startNew: true });
  assert.notEqual(threadB, foreignThread);

  await assert.rejects(
    selectConversation(memory, projectB, { requestedThreadId: foreignThread }),
    /does not exist in this project/,
  );
  rmSync(base, { recursive: true, force: true });
});