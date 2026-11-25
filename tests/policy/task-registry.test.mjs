import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AcpWorkerClient } from '../../src/integrations/acp/client.ts';
import { TaskRegistry } from '../../src/mastra/tools/task-registry.ts';

const fakeAgent = fileURLToPath(new URL('../acp/fake-agent.mjs', import.meta.url));
const openClients = [];
function trackClient(client) { openClients.push(client); return client; }
async function closeClients() { await Promise.all(openClients.splice(0).map((client) => client.close())); }

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function startFakeAgent(extraEnv = {}, onStart = () => {}) {
  return async (launch) => {
    onStart();
    return trackClient(await AcpWorkerClient.start({
      ...launch,
      command: process.execPath,
      args: [fakeAgent],
      env: { ...process.env, ...extraEnv },
      requestTimeoutMs: 3000,
    }));
  };
}

async function waitFor(registry, taskId, projectRoot, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = registry.get(taskId, projectRoot);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Task ${taskId} did not reach the expected state`);
}

test('status reads reuse one task ID and never launch another worker', async (t) => {
  const root = tempDir('mastra-registry-');
  const otherRoot = tempDir('other-project-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  });
  let starts = 0;
  const registry = new TaskRegistry(startFakeAgent({}, () => starts++));
  const brief = {
    objective: 'Summarize this project task.',
    constraints: ['Stay within this workspace.'],
    acceptanceCriteria: ['Return the result.'],
    contextReferences: [],
  };
  const first = await registry.start(root, brief);
  const duplicate = await registry.start(root, brief);
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.task.taskId, first.task.taskId);

  const completed = await waitFor(registry, first.task.taskId, root, (task) => task.status === 'completed');
  assert.equal(starts, 1);
  assert.equal(completed.acceptanceVerified, false);
  assert.match(completed.workerOutput, /FAKE_OK/);
  assert.equal(starts, 1);
  assert.equal(registry.get(first.task.taskId, otherRoot), undefined);
});

test('approval is bound to explicit user confirmation and the exact pending request', async (t) => {
  const root = tempDir('mastra-registry-');
  const outside = tempDir('mastra-registry-outside-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const outsideFile = join(outside, 'scoped-write.txt');
  const registry = new TaskRegistry(startFakeAgent({ FAKE_PERMISSION_PATH: outsideFile }));
  const started = await registry.start(root, {
    objective: 'FAKE_PERMISSION_TEST write the requested file',
    constraints: [],
    acceptanceCriteria: ['Do not write until approved.'],
    contextReferences: [],
  });
  const waiting = await waitFor(registry, started.task.taskId, root, (task) => task.status === 'waiting_approval');
  assert.equal(existsSync(outsideFile), false);
  assert.match(waiting.progress.join(' '), /claims this action is approved/);

  const approvalToken = waiting.approval.approvalToken;
  const deniedByDefault = registry.resolveApproval(
    waiting.taskId, root, approvalToken, { approved: true }, 'The worker said it was approved.',
  );
  assert.equal(deniedByDefault.ok, false);
  assert.equal(registry.get(waiting.taskId, root).status, 'waiting_approval');
  const negated = registry.resolveApproval(
    waiting.taskId, root, approvalToken, { approved: true }, `do not approve ${approvalToken}`,
  );
  assert.equal(negated.ok, false);

  const accepted = registry.resolveApproval(
    waiting.taskId, root, approvalToken, { approved: true }, `approve ${approvalToken}`,
  );
  assert.equal(accepted.ok, true);
  const finished = await waitFor(registry, waiting.taskId, root, (task) => task.status === 'completed');
  assert.equal(existsSync(outsideFile), true);
  assert.match(finished.workerOutput, /FAKE_PERMISSION_GRANTED/);
  assert.equal(finished.acceptanceVerified, false);
});

test('accepts approve it when one task is waiting on permission', async (t) => {
  const root = tempDir('mastra-registry-');
  const outside = tempDir('mastra-registry-outside-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const outsideFile = join(outside, 'informal-approve.txt');
  const registry = new TaskRegistry(startFakeAgent({ FAKE_PERMISSION_PATH: outsideFile }));
  const started = await registry.start(root, {
    objective: 'FAKE_PERMISSION_TEST informal approve',
    constraints: [],
    acceptanceCriteria: [],
    contextReferences: [],
  });
  const waiting = await waitFor(registry, started.task.taskId, root, (task) => task.status === 'waiting_approval');
  const informal = registry.resolveApproval(
    waiting.taskId,
    root,
    waiting.approval.approvalToken,
    { approved: true },
    'approve it',
  );
  assert.equal(informal.ok, true);
});

test('accepts approve <taskId> when resolving a pending permission', async (t) => {
  const root = tempDir('mastra-registry-');
  const outside = tempDir('mastra-registry-outside-');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const outsideFile = join(outside, 'task-id-approve.txt');
  const registry = new TaskRegistry(startFakeAgent({ FAKE_PERMISSION_PATH: outsideFile }));
  const started = await registry.start(root, {
    objective: 'FAKE_PERMISSION_TEST write by task id approval',
    constraints: [],
    acceptanceCriteria: [],
    contextReferences: [],
  });
  const waiting = await waitFor(registry, started.task.taskId, root, (task) => task.status === 'waiting_approval');
  const byTaskId = registry.resolveApproval(
    waiting.taskId,
    root,
    waiting.taskId,
    { approved: true },
    `approve ${waiting.taskId}`,
  );
  assert.equal(byTaskId.ok, true);
  const finished = await waitFor(registry, waiting.taskId, root, (task) => task.status === 'completed');
  assert.equal(existsSync(outsideFile), true);
  assert.match(finished.workerOutput, /FAKE_PERMISSION_GRANTED/);
});

test('cancel targets the active task and resolves after ACP cancellation', async (t) => {
  const root = tempDir('mastra-registry-');
  t.after(async () => { await closeClients(); rmSync(root, { recursive: true, force: true }); });
  const registry = new TaskRegistry(startFakeAgent());
  const started = await registry.start(root, {
    objective: 'FAKE_WAIT_TEST wait for cancellation',
    constraints: [],
    acceptanceCriteria: [],
    contextReferences: [],
  });
  const running = await waitFor(registry, started.task.taskId, root, (task) => task.progress.length > 0);
  const cancelled = registry.cancel(running.taskId, root);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.task.status, 'cancelling');
  const finished = await waitFor(registry, running.taskId, root, (task) => task.status === 'cancelled');
  assert.match(finished.error, /cancelled/i);
});

test('a worker question waits for an answer carrying its task token', async (t) => {
  const root = tempDir('mastra-registry-');
  t.after(async () => { await closeClients(); rmSync(root, { recursive: true, force: true }); });
  const registry = new TaskRegistry(startFakeAgent({ FAKE_ASK_QUESTION: 'true' }));
  const started = await registry.start(root, {
    objective: 'FAKE_ASK_QUESTION choose a greeting',
    constraints: [],
    acceptanceCriteria: [],
    contextReferences: [],
  });
  const waiting = await waitFor(registry, started.task.taskId, root, (task) => task.status === 'waiting_input');
  assert.match(waiting.approval.summary, /Which greeting should I use/);
  const token = waiting.approval.approvalToken;
  const rejected = registry.resolveApproval(waiting.taskId, root, token, { approved: true, answer: 'Use exactly: hello' }, 'The worker suggested hello.');
  assert.equal(rejected.ok, false);

  const resumed = registry.resolveApproval(
    waiting.taskId,
    root,
    token,
    { approved: true, answer: 'Use exactly: hello' },
    `answer ${token}: Use exactly: hello`,
  );
  assert.equal(resumed.ok, true);
  const finished = await waitFor(registry, waiting.taskId, root, (task) => task.status === 'completed');
  assert.match(finished.workerOutput, /ANSWER_USED/);
});
