import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AcpWorkerClient } from '../../src/integrations/acp/client.ts';
import { SqliteTaskStore } from '../../src/context/task-store.ts';
import { TaskRegistry } from '../../src/mastra/tools/task-registry.ts';

const fakeAgent = fileURLToPath(new URL('../acp/fake-agent.mjs', import.meta.url));
const clients = [];
const startFake = async (launch) => {
  const client = await AcpWorkerClient.start({ ...launch, command: process.execPath, args: [fakeAgent], env: process.env, requestTimeoutMs: 3000 });
  clients.push(client);
  return client;
};
const closeClients = async () => await Promise.all(clients.splice(0).map((client) => client.close()));
const root = () => mkdtempSync(join(tmpdir(), 'worker-registry-'));
const brief = (objective) => ({ objective, constraints: [], acceptanceCriteria: [], contextReferences: [] });
const noopPreflightRegistry = (startClient, options = {}) => new TaskRegistry(startClient, options.store, { ...options, preflight: options.preflight ?? (async () => {}) });
async function waitFor(registry, id, projectRoot, status) {
  for (let i = 0; i < 300; i++) {
    const task = registry.get(id, projectRoot);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Task did not reach ${status}`);
}

test('queued tasks hydrate and run after a registry restart', async (t) => {
  const project = root();
  const db = join(project, 'assistant-tasks.db');
  t.after(async () => {
    await closeClients();
    try { rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* Windows may hold the SQLite file briefly. */ }
  });
  const now = new Date().toISOString();
  const store = new SqliteTaskStore(db);
  store.upsert({
    taskId: 'queued-task',
    projectRoot: project,
    status: 'queued',
    objective: 'second task',
    brief: brief('second task'),
    taskText: 'second',
    createdAt: now,
    updatedAt: now,
    progress: [],
  });
  store.upsert({
    taskId: 'was-running',
    projectRoot: project,
    status: 'running',
    objective: 'was running',
    brief: brief('was running'),
    taskText: 'running',
    createdAt: now,
    updatedAt: now,
    progress: ['partial'],
  });
  store.close();
  const registry = new TaskRegistry(startFake, new SqliteTaskStore(db));
  const finished = await waitFor(registry, 'queued-task', project, 'completed');
  assert.match(finished.workerOutput, /FAKE_OK/);
  assert.equal(registry.get('was-running', project).status, 'interrupted');
});

test('second task waits in FIFO and starts after the first', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  let starts = 0;
  const registry = noopPreflightRegistry(async (launch) => { starts++; return startFake(launch); });
  const first = await registry.start(project, brief('FAKE_WAIT_TEST first'));
  const second = await registry.start(project, brief('second task'));
  assert.equal(second.task.status, 'queued');
  registry.cancel(first.task.taskId, project);
  await waitFor(registry, first.task.taskId, project, 'cancelled');
  const done = await waitFor(registry, second.task.taskId, project, 'completed');
  assert.equal(done.evidence.verified, false);
  assert.ok(starts >= 1);
});

test('timeout releases slot and launches queued task', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  const registry = noopPreflightRegistry(startFake, { timeoutMs: 800 });
  const first = await registry.start(project, brief('FAKE_WAIT_TEST first'));
  const second = await registry.start(project, brief('second'));
  let timedOut;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const task = registry.get(first.task.taskId, project);
    if (task && (task.status === 'cancelled' || task.status === 'failed')) {
      timedOut = task;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(timedOut, 'expected the first task to time out or cancel');
  assert.match(timedOut.error ?? '', /timed out|cancelled/i);
  await waitFor(registry, second.task.taskId, project, 'completed');
});

test('missing worker fails before process start', async (t) => {
  const project = root();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  let starts = 0;
  const registry = new TaskRegistry(async () => { starts++; throw new Error('unexpected start'); }, undefined, { preflight: async () => { throw new Error('Worker command not found: fake'); } });
  const task = await registry.start(project, brief('work'));
  const failed = await waitFor(registry, task.task.taskId, project, 'failed');
  assert.match(failed.error, /command not found/);
  assert.equal(starts, 0);
});

test('managed tasks preserve and dispatch the selected Claude worker', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const preflightWorkers = [];
  const registry = new TaskRegistry(startFake, undefined, {
    preflight: async (_projectRoot, worker) => { preflightWorkers.push(worker); },
  });
  const started = await registry.start(project, { ...brief('Claude task'), worker: 'claude' });
  assert.equal(started.task.worker, 'claude');
  const completed = await waitFor(registry, started.task.taskId, project, 'completed');
  assert.equal(completed.worker, 'claude');
  assert.deepEqual(preflightWorkers, ['claude']);
});

test('managed tasks preserve and dispatch the selected Cursor worker', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  const preflightWorkers = [];
  const registry = new TaskRegistry(startFake, undefined, {
    preflight: async (_projectRoot, worker) => { preflightWorkers.push(worker); },
  });
  const started = await registry.start(project, { ...brief('Cursor task'), worker: 'cursor' });
  assert.equal(started.task.worker, 'cursor');
  const completed = await waitFor(registry, started.task.taskId, project, 'completed');
  assert.equal(completed.worker, 'cursor');
  assert.deepEqual(preflightWorkers, ['cursor']);
});

test('git changes are exposed as evidence and success stays unverified', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  execFileSync('git', ['init'], { cwd: project, stdio: 'ignore' });
  const registry = noopPreflightRegistry(startFake);
  const task = await registry.start(project, brief('FAKE_EDIT_FILE'));
  const done = await waitFor(registry, task.task.taskId, project, 'completed');
  assert.deepEqual(done.evidence.changedFiles, ['evidence-created.txt']);
  assert.equal(done.evidence.workerClaimedSuccess, true);
  assert.equal(done.evidence.verified, false);
});
