import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localProjectLookup, lookupScopedMemory, readProjectFile, searchProjectFiles } from '../../src/mastra/tools/local-lookup.ts';

function project() { return mkdtempSync(join(tmpdir(), 'mastra-local-lookup-')); }

test('search returns actual project-relative source paths and paginates bounded results', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'notes.md'), Array.from({ length: 30 }, (_, i) => `needle result ${i + 1}`).join('\n'));
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dependency.md'), 'needle must not appear');

  const page = await searchProjectFiles({ projectRoot: root, query: 'needle', limit: 2, offset: 2 });
  assert.equal(page.ok, true);
  assert.equal(page.totalMatches, 30);
  assert.equal(page.matches.length, 2);
  assert.equal(page.matches[0].path, 'src/notes.md');
  assert.equal(page.matches[0].line, 3);
  assert.equal(page.nextOffset, 4);
  assert.equal(page.incomplete, false);
});

test('file reads are byte-bounded and return an offset for continuation', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'readme.txt'), '0123456789abcdefghij');

  const first = await readProjectFile({ projectRoot: root, path: 'readme.txt', maxBytes: 10 });
  const second = await readProjectFile({ projectRoot: root, path: 'readme.txt', offset: first.nextOffset, maxBytes: 10 });
  assert.equal(first.text, '0123456789');
  assert.equal(first.truncated, true);
  assert.equal(first.nextOffset, 10);
  assert.equal(second.text, 'abcdefghij');
  assert.equal(second.truncated, false);
  assert.deepEqual(first.source, { type: 'project-file', path: 'readme.txt', startByte: 0, endByte: 10 });
});

test('file reads reject traversal and secret-like files; tool surfaces the error', async (t) => {
  const root = project();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, '.env'), 'API_KEY=not-for-tools');

  await assert.rejects(readProjectFile({ projectRoot: root, path: '../outside.txt' }), /outside the current project workspace/);
  await assert.rejects(readProjectFile({ projectRoot: root, path: '.env' }), /not available to project lookup/);
  const result = await localProjectLookup.execute({ operation: 'read', path: '../outside.txt' });
  assert.equal(result.ok, false);
  assert.match(result.message, /outside the current project workspace/);
});

test('memory lookup returns only the requested project scope and cites record IDs', async (t) => {
  const rootA = project();
  const rootB = project();
  t.after(() => {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });
  const record = { id: 'memory-alpha', scope: 'project', kind: 'fact', key: 'project-name', value: 'Alpha project', source: 'user-confirmed', sourceId: null, revision: 1 };
  const makeStore = records => ({
    list: async ({ scope, query }) => {
      assert.equal(scope, 'project');
      assert.equal(query, 'Alpha');
      return records;
    },
  });
  const resultA = await lookupScopedMemory({
    projectRoot: rootA, scope: 'project', query: 'Alpha',
    store: { ...makeStore([record]), close: async () => {} },
  });
  const resultB = await lookupScopedMemory({
    projectRoot: rootB, scope: 'project', query: 'Alpha',
    store: { ...makeStore([]), close: async () => {} },
  });
  assert.equal(resultA.records.length, 1);
  assert.equal(resultA.sources[0].id, record.id);
  assert.equal(resultA.records[0].scope, 'project');
  assert.equal(resultB.records.length, 0);
});
