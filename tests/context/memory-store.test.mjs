import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { selectConversation } from '../../src/context/conversations.ts';
import { ScopedMemoryStore } from '../../src/context/memory-store.ts';

// libSQL on Windows keeps the database file locked for a moment after close(). Close first,
// give the handle time to drop, then remove the folder. A temp folder that still cannot be
// removed is left behind rather than failing the test.
async function closeAndRemove(directory, stores) {
  await Promise.all(stores.filter(Boolean).map((store) => store.close()));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

test('project facts stay isolated while user preferences remain shared', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-memory-'));
  const databasePath = join(directory, 'memory.db');
  const first = new ScopedMemoryStore({ databasePath, projectRoot: join(directory, 'project-a') });
  const second = new ScopedMemoryStore({ databasePath, projectRoot: join(directory, 'project-b') });
  t.after(() => closeAndRemove(directory, [first, second]));

  await first.remember({ scope: 'user', kind: 'preference', key: 'language', value: 'English', source: 'user-confirmed' });
  await first.remember({ scope: 'project', kind: 'fact', key: 'database', value: 'SQLite', source: 'user-confirmed' });

  const secondContext = await second.list();
  assert.deepEqual(secondContext.map(item => [item.scope, item.key]), [['user', 'language']]);
});

test('the selected terminal conversation is restored from durable storage after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-conversation-'));
  const databasePath = join(directory, 'mastra.db');
  const projectRoot = join(directory, 'project');
  const firstStorage = new LibSQLStore({ id: 'memory-test-first', url: pathToFileURL(databasePath).href });
  await firstStorage.init();
  const firstMemory = new Memory({ storage: firstStorage });
  const firstId = await selectConversation(firstMemory, projectRoot);
  await firstMemory.saveMessages({
    messages: [{ id: 'message-1', threadId: firstId, resourceId: firstMemory && (await firstMemory.getThreadById({ threadId: firstId }))?.resourceId, role: 'user', type: 'text', content: { format: 2, parts: [{ type: 'text', text: 'keep this thread' }] }, createdAt: new Date() }],
  });

  const secondStorage = new LibSQLStore({ id: 'memory-test-second', url: pathToFileURL(databasePath).href });
  await secondStorage.init();
  t.after(() => closeAndRemove(directory, [firstStorage, secondStorage]));
  const secondMemory = new Memory({ storage: secondStorage });
  const restoredId = await selectConversation(secondMemory, projectRoot);
  assert.equal(restoredId, firstId);
  assert.equal((await secondMemory.recall({ threadId: restoredId, perPage: 10 })).messages.length, 1);
});

test('corrections preserve history while retrieval uses only the current fact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-memory-'));
  const store = new ScopedMemoryStore({ databasePath: join(directory, 'memory.db'), projectRoot: directory });
  t.after(() => closeAndRemove(directory, [store]));

  const old = await store.remember({ scope: 'project', kind: 'fact', key: 'database', value: 'JSON', source: 'user-confirmed' });
  const current = await store.remember({ scope: 'project', kind: 'fact', key: 'database', value: 'SQLite', source: 'user-confirmed', correct: true });
  assert.equal(current.revision, 2);
  assert.equal(current.replaces, old.id);
  assert.deepEqual((await store.list()).map(item => item.value), ['SQLite']);
  assert.equal((await store.list({ includeHistory: true })).length, 2);
});

test('forgetting a source removes its derived memory and export omits credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-memory-'));
  const store = new ScopedMemoryStore({ databasePath: join(directory, 'memory.db'), projectRoot: directory });
  t.after(() => closeAndRemove(directory, [store]));

  const fact = await store.remember({ scope: 'project', kind: 'fact', key: 'origin', value: 'from a chat', source: 'conversation', sourceId: 'thread-1' });
  await store.remember({ scope: 'project', kind: 'summary', key: 'origin-summary', value: 'derived summary', source: 'summary', sourceId: 'thread-1', derivedFrom: [fact.id] });
  const forgotten = await store.forgetSource({ scope: 'project', sourceId: 'thread-1' });
  assert.equal(forgotten, 2);
  assert.equal((await store.list()).length, 0);

  await assert.rejects(
    store.remember({ scope: 'user', kind: 'preference', key: 'api-key', value: 'sk-1234567890abcdef', source: 'user-confirmed' }),
    /credential/,
  );
  const exported = await store.export();
  assert.equal(JSON.stringify(exported).includes('api-key'), false);
  assert.equal(JSON.stringify(exported).includes('sk-1234567890abcdef'), false);
});

test('forgetting a correction source removes that revision and key forgetting removes all history', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mastra-memory-'));
  const store = new ScopedMemoryStore({ databasePath: join(directory, 'memory.db'), projectRoot: directory });
  t.after(() => closeAndRemove(directory, [store]));

  await store.remember({ scope: 'project', kind: 'fact', key: 'database', value: 'JSON', source: 'conversation', sourceId: 'thread-old' });
  const corrected = await store.remember({ scope: 'project', kind: 'fact', key: 'database', value: 'SQLite', source: 'correction', sourceId: 'thread-new', correct: true });
  await store.remember({ scope: 'project', kind: 'summary', key: 'database-summary', value: 'derived from correction', source: 'summary', sourceId: 'thread-new', derivedFrom: [corrected.id] });
  assert.equal(await store.forgetSource({ scope: 'project', sourceId: 'thread-new' }), 2);
  assert.equal((await store.list()).length, 0);
  assert.equal((await store.list({ includeHistory: true })).length, 1);
  const oldTheme = await store.remember({ scope: 'project', kind: 'fact', key: 'theme', value: 'dark', source: 'conversation', sourceId: 'thread-a' });
  await store.remember({ scope: 'project', kind: 'summary', key: 'theme-summary-a', value: 'derived from old fact', source: 'summary', sourceId: 'thread-a', derivedFrom: [oldTheme.id] });
  const correctedTheme = await store.remember({ scope: 'project', kind: 'fact', key: 'theme', value: 'light', source: 'correction', sourceId: 'thread-b', correct: true });
  await store.remember({ scope: 'project', kind: 'summary', key: 'theme-summary-b', value: 'derived from corrected fact', source: 'summary', sourceId: 'thread-b', derivedFrom: [correctedTheme.id] });
  await store.remember({ scope: 'project', kind: 'fact', key: 'neighbor', value: 'keep this', source: 'conversation', sourceId: 'thread-a' });
  const neighbor = (await store.list({ query: 'neighbor' }))[0];
  await store.remember({ scope: 'project', kind: 'summary', key: 'neighbor-summary', value: 'also keep this', source: 'summary', sourceId: 'thread-a', derivedFrom: [neighbor.id] });
  assert.equal((await store.forget({ scope: 'project', key: 'theme' })).forgotten, 4);
  assert.deepEqual((await store.list()).map(item => item.key).sort(), ['neighbor', 'neighbor-summary']);
  assert.equal((await store.forget({ scope: 'project', key: 'database' })).forgotten, 1);
  assert.deepEqual((await store.list()).map(item => item.key).sort(), ['neighbor', 'neighbor-summary']);
  assert.equal(await store.forgetSource({ scope: 'project', sourceId: 'thread-a' }), 2);
  assert.equal((await store.list()).length, 0);
});
