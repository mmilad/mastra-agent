import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteTaskStore } from '../../src/context/task-store.ts';
import { TaskRegistry } from '../../src/mastra/tools/task-registry.ts';

function tempDir() { return mkdtempSync(join(tmpdir(), 'assistant-tasks-')); }
function cleanup(path) {
  try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may briefly retain SQLite file handles. */ }
}
const brief = { objective: 'Persist this task', constraints: [], acceptanceCriteria: [], contextReferences: [] };

test('tasks remain visible after a registry restart', async (t) => {
  const dir = tempDir();
  const db = join(dir, 'assistant-tasks.db');
  t.after(() => cleanup(dir));
  const firstStore = new SqliteTaskStore(db);
  // A worker that never finishes keeps the task active, so the restart must mark it interrupted.
  const first = new TaskRegistry(() => new Promise(() => {}), firstStore);
  const saved = first.start(dir, brief).task;
  // Let the registry finish its asynchronous preflight before the store closes.
  await new Promise((resolve) => setTimeout(resolve, 300));
  firstStore.close();
  const secondStore = new SqliteTaskStore(db);
  const second = new TaskRegistry(undefined, secondStore);
  assert.equal(second.get(saved.taskId, dir).status, 'interrupted');
  secondStore.close();
});

test('waiting approval is interrupted without restarting its worker', async (t) => {
  const dir = tempDir();
  const db = join(dir, 'assistant-tasks.db');
  t.after(() => cleanup(dir));
  let starts = 0;
  const firstStore = new SqliteTaskStore(db);
  const first = new TaskRegistry(async () => {
    starts++;
    return {
      close: async () => {},
      requestPermission: async () => {},
    };
  }, firstStore);
  // Store a waiting task directly to model the persisted suspend point.
  const record = {
    taskId: 'waiting-task', projectRoot: dir, status: 'waiting_approval', objective: brief.objective,
    brief, taskText: 'test task', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    progress: ['waiting'], approval: { approvalToken: 'token', projectRoot: dir, taskFingerprint: 'fp', kind: 'permission', summary: 'approve?', expiresAt: Date.now() + 60000 },
  };
  firstStore.upsert(record);
  firstStore.close();
  const secondStore = new SqliteTaskStore(db);
  const second = new TaskRegistry(async () => { starts++; throw new Error('must not restart'); }, secondStore);
  const restored = second.get(record.taskId, dir);
  assert.equal(restored.status, 'interrupted');
  assert.equal(restored.approval, undefined);
  assert.match(restored.error, /not resumed automatically/);
  assert.equal(starts, 0);
  secondStore.close();
});

test('completed tasks remain completed after a registry restart', (t) => {
  const dir = tempDir();
  const db = join(dir, 'assistant-tasks.db');
  t.after(() => cleanup(dir));
  const store = new SqliteTaskStore(db);
  store.upsert({ taskId: 'done', projectRoot: dir, status: 'completed', objective: brief.objective, brief, taskText: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: [], workerOutput: 'ok', workerStopReason: 'end_turn' });
  store.close();
  const reopened = new SqliteTaskStore(db);
  const registry = new TaskRegistry(undefined, reopened);
  assert.equal(registry.get('done', dir).status, 'completed');
  reopened.close();
});
