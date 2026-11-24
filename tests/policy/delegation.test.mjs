import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AcpWorkerClient } from '../../src/integrations/acp/client.ts';
import { runCodexDelegation, runWorkerDelegation } from '../../src/mastra/tools/delegate-to-codex.ts';

const fakeAgent = fileURLToPath(new URL('../acp/fake-agent.mjs', import.meta.url));
const openClients = [];
function trackClient(client) { openClients.push(client); return client; }
async function closeClients() { await Promise.all(openClients.splice(0).map((client) => client.close())); }

function project() {
  const root = mkdtempSync(join(tmpdir(), 'mastra-delegation-'));
  return root;
}

function startFakeAgent(extraEnv = {}, onLaunch = () => {}) {
  return async (launch) => trackClient(await AcpWorkerClient.start({
    ...onLaunch(launch),
    ...launch,
    command: process.execPath,
    args: [fakeAgent],
    env: { ...process.env, ...extraEnv },
    requestTimeoutMs: 3000,
  }));
}

test('holds an out-of-workspace permission, then honors only its matching approval', async (t) => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), 'mastra-outside-'));
  t.after(async () => {
    await closeClients();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const outsidePath = join(outside, 'approved-outside-project.txt');
  const task = 'FAKE_PERMISSION_TEST create the requested file';
  const suspensions = [];
  const dependencies = { startClient: startFakeAgent({ FAKE_PERMISSION_PATH: outsidePath }) };
  const pending = await runCodexDelegation(task, root, {
    agent: { suspend: async (payload) => suspensions.push(payload) },
  }, dependencies);

  assert.equal(pending, undefined);
  assert.equal(existsSync(outsidePath), false, 'the worker must not execute the out-of-scope write before approval');
  assert.equal(suspensions.length, 1);
  const approval = suspensions[0];
  assert.equal(approval.kind, 'permission');
  assert.equal(approval.projectRoot, root);
  assert.match(approval.summary, /outside the authorized project workspace/);

  let repeatedSuspensions = 0;
  const resumed = await runCodexDelegation(task, root, {
    agent: {
      suspend: async () => repeatedSuspensions++,
      suspendPayload: approval,
      resumeData: { approvalToken: approval.approvalToken, approved: true },
    },
  }, dependencies);
  assert.equal(repeatedSuspensions, 0);
  assert.equal(resumed.stopReason, 'end_turn');
  assert.match(resumed.response, /FAKE_PERMISSION_GRANTED/);
  assert.equal(existsSync(outsidePath), true, 'the matching human approval should permit this exact action');
});

test('denial and expiry return visible outcomes without starting a worker', async (t) => {
  const root = project();
  t.after(async () => { await closeClients(); rmSync(root, { recursive: true, force: true }); });
  const task = 'FAKE_PERMISSION_TEST create the requested file';
  const approval = {
    approvalToken: 'review-token',
    projectRoot: root,
    taskFingerprint: (await import('../../src/policy/workspace.ts')).taskFingerprint(task),
    kind: 'permission',
    requestFingerprint: 'unused',
    operation: 'edit: outside path',
    summary: 'Approval needed',
    expiresAt: Date.now() + 60_000,
  };
  let starts = 0;
  const startClient = async () => {
    starts += 1;
    throw new Error('worker must not start for a denied or expired approval');
  };
  const denied = await runCodexDelegation(task, root, {
    agent: { suspendPayload: approval, resumeData: { approvalToken: approval.approvalToken, approved: false } },
  }, { startClient });
  assert.equal(denied.stopReason, 'permission_denied');
  assert.match(denied.response, /denied/);

  const expired = await runCodexDelegation(task, root, {
    agent: {
      suspendPayload: { ...approval, expiresAt: Date.now() - 1 },
      resumeData: { approvalToken: approval.approvalToken, approved: true },
    },
  }, { startClient });
  assert.equal(expired.stopReason, 'approval_expired');
  assert.match(expired.response, /expired/);
  assert.equal(starts, 0);
});

test('surfaces a provider question and includes the answer only after explicit resume', async (t) => {
  const root = project();
  t.after(async () => { await closeClients(); rmSync(root, { recursive: true, force: true }); });
  const task = 'FAKE_ASK_QUESTION choose a greeting';
  const suspensions = [];
  const dependencies = { startClient: startFakeAgent({ FAKE_ASK_QUESTION: 'true' }) };
  const pending = await runCodexDelegation(task, root, {
    agent: { suspend: async (payload) => suspensions.push(payload) },
  }, dependencies);
  assert.equal(pending, undefined);
  assert.equal(suspensions[0]?.kind, 'question');

  const question = suspensions[0];
  const resumed = await runCodexDelegation(task, root, {
    agent: {
      suspend: async () => assert.fail('the answer should resolve the existing question'),
      suspendPayload: question,
      resumeData: { approvalToken: question.approvalToken, approved: true, answer: 'Use exactly: hello' },
    },
  }, dependencies);
  assert.equal(resumed.stopReason, 'end_turn');
  assert.match(resumed.response, /ANSWER_USED/);
});

test('Cursor question handling uses the shared suspend and resume flow', async (t) => {
  const root = project();
  t.after(async () => { await closeClients(); rmSync(root, { recursive: true, force: true }); });
  const task = 'FAKE_ASK_QUESTION choose a greeting';
  const suspensions = [];
  let cursorLaunch;
  const dependencies = {
    startClient: startFakeAgent({ FAKE_ASK_QUESTION: 'true' }, (launch) => { cursorLaunch = launch; }),
  };
  const pending = await runWorkerDelegation(task, root, 'cursor', {
    agent: { suspend: async (payload) => suspensions.push(payload) },
  }, dependencies);

  assert.equal(pending, undefined);
  assert.equal(cursorLaunch.command, process.env.CURSOR_AGENT_COMMAND ?? 'cursor');
  assert.deepEqual(cursorLaunch.args, ['agent', '--sandbox', 'enabled', 'acp']);
  assert.equal(suspensions[0]?.kind, 'question');

  const question = suspensions[0];
  const resumed = await runWorkerDelegation(task, root, 'cursor', {
    agent: {
      suspend: async () => assert.fail('the answer should resolve the existing question'),
      suspendPayload: question,
      resumeData: { approvalToken: question.approvalToken, approved: true, answer: 'Use exactly: hello' },
    },
  }, dependencies);
  assert.equal(resumed.stopReason, 'end_turn');
  assert.match(resumed.response, /ANSWER_USED/);
});

test('Cursor permission requests use the shared scoped approval policy', async (t) => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), 'mastra-cursor-outside-'));
  t.after(async () => {
    await closeClients();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  const outsidePath = join(outside, 'cursor-outside.txt');
  const suspensions = [];
  const pending = await runWorkerDelegation(
    'FAKE_PERMISSION_TEST create a file', root, 'cursor',
    { agent: { suspend: async (payload) => suspensions.push(payload) } },
    { startClient: startFakeAgent({ FAKE_PERMISSION_PATH: outsidePath }) },
  );

  assert.equal(pending, undefined);
  assert.equal(existsSync(outsidePath), false);
  assert.equal(suspensions[0]?.kind, 'permission');
  assert.equal(suspensions[0]?.projectRoot, root);
  assert.match(suspensions[0]?.summary, /outside the authorized project workspace/);
});

test('returns a visible result when the caller cancels before dispatch', async (t) => {
  const root = project();
  t.after(async () => { await closeClients(); rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  controller.abort();
  const result = await runCodexDelegation('FAKE_CANCEL_TEST', root, {
    abortSignal: controller.signal,
  }, { startClient: startFakeAgent() });
  assert.equal(result.stopReason, 'cancelled');
  assert.match(result.response, /cancelled/);
});
