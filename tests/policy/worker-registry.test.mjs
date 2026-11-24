import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AcpWorkerClient } from '../../src/integrations/acp/client.ts';
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
async function waitFor(registry, id, projectRoot, status) {
  for (let i = 0; i < 300; i++) {
    const task = registry.get(id, projectRoot);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Task did not reach ${status}`);
}

test('second task waits in FIFO and starts after the first', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  let starts = 0;
  const registry = new TaskRegistry(async (launch) => { starts++; return startFake(launch); });
  const first = registry.start(project, brief('FAKE_WAIT_TEST first'));
  const second = registry.start(project, brief('second task'));
  assert.equal(second.task.status, 'queued');
  registry.cancel(first.task.taskId, project);
  await waitFor(registry, first.task.taskId, project, 'cancelled');
  const done = await waitFor(registry, second.task.taskId, project, 'completed');
  assert.equal(done.evidence.verified, false);
  // The first task was cancelled during preflight, before its worker launched; only the second worker started.
  assert.equal(starts, 1);
});

test('timeout releases slot and launches queued task', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  const registry = new TaskRegistry(startFake, undefined, { timeoutMs: 1500 });
  const first = registry.start(project, brief('FAKE_WAIT_TEST first'));
  const second = registry.start(project, brief('second'));
  const timedOut = await waitFor(registry, first.task.taskId, project, 'cancelled');
  assert.match(timedOut.error, /timed out/i);
  await waitFor(registry, second.task.taskId, project, 'completed');
});

test('missing worker fails before process start', async (t) => {
  const project = root();
  t.after(() => rmSync(project, { recursive: true, force: true }));
  let starts = 0;
  const registry = new TaskRegistry(async () => { starts++; throw new Error('unexpected start'); }, undefined, { preflight: async () => { throw new Error('Worker command not found: fake'); } });
  const task = registry.start(project, brief('work'));
  const failed = await waitFor(registry, task.task.taskId, project, 'failed');
  assert.match(failed.error, /command not found/);
  assert.equal(starts, 0);
});

test('managed tasks preserve and dispatch the selected Cursor worker', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  const preflightWorkers = [];
  const registry = new TaskRegistry(startFake, undefined, {
    preflight: async (_projectRoot, worker) => { preflightWorkers.push(worker); },
  });
  const started = registry.start(project, { ...brief('Cursor task'), worker: 'cursor' });
  assert.equal(started.task.worker, 'cursor');
  const completed = await waitFor(registry, started.task.taskId, project, 'completed');
  assert.equal(completed.worker, 'cursor');
  assert.deepEqual(preflightWorkers, ['cursor']);
});

test('git changes are exposed as evidence and success stays unverified', async (t) => {
  const project = root();
  t.after(async () => { await closeClients(); rmSync(project, { recursive: true, force: true }); });
  execFileSync('git', ['init'], { cwd: project, stdio: 'ignore' });
  const registry = new TaskRegistry(startFake);
  const task = registry.start(project, brief('FAKE_EDIT_FILE'));
  const done = await waitFor(registry, task.task.taskId, project, 'completed');
  assert.deepEqual(done.evidence.changedFiles, ['evidence-created.txt']);
  assert.equal(done.evidence.workerClaimedSuccess, true);
  assert.equal(done.evidence.verified, false);
});
