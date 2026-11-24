import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { ACP_UNHANDLED, AcpWorkerClient } from '../../src/integrations/acp/client.ts';

const fixture = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const cwd = tmpdir();

async function startFake(env = {}) {
  return AcpWorkerClient.start({
    command: process.execPath,
    args: [fixture],
    cwd,
    env: { ...process.env, ...env },
    requestTimeoutMs: 3000,
  });
}

test('initializes, reports negotiated capabilities, creates a session, and streams a prompt', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  assert.equal(client.capabilities.loadSession, false);
  assert.equal(client.capabilities.sessionList, true);
  assert.equal(client.capabilities.authenticationMethods[0]?.id, 'fake-auth');

  const updates = [];
  client.events.on('update', (update) => updates.push(update));
  const sessionId = await client.newSession(cwd);
  const result = await client.prompt(sessionId, 'hello');
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(updates[0]?.method, 'session/update');
  assert.equal(updates[0]?.params.update.content.text, 'FAKE_OK');
});

test('only offers resume when the agent advertises loadSession', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  await assert.rejects(client.loadSession('old-session', cwd), /did not advertise session load\/resume/);

  const resumable = await startFake({ FAKE_LOAD_SESSION: 'true' });
  t.after(() => resumable.close());
  assert.equal(resumable.capabilities.loadSession, true);
  await resumable.loadSession('old-session', cwd);
  assert.equal(resumable.sessionId, 'old-session');
});

test('unknown blocking requests fail clearly instead of leaving the prompt pending', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  let rejection;
  client.events.on('clientRequestRejected', (event) => {
    rejection = event;
  });
  const sessionId = await client.newSession(cwd);
  const result = await client.prompt(sessionId, 'unknown-request');
  assert.equal(rejection.method, 'provider/unknown_blocking');
  assert.match(rejection.error.message, /Unsupported blocking ACP client request/);
  assert.equal(result.stopReason, 'end_turn');
});

test('a custom handler can explicitly leave an unknown ACP request unsupported', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  client.setClientRequestHandler(() => ACP_UNHANDLED);
  const sessionId = await client.newSession(cwd);
  const result = await client.prompt(sessionId, 'unknown-request');
  assert.equal(result.stopReason, 'end_turn');
});

test('permission and Cursor plan requests default to cancellation rather than hanging', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  const sessionId = await client.newSession(cwd);
  const permissionResult = await client.prompt(sessionId, 'wait-permission');
  assert.equal(permissionResult.stopReason, 'end_turn');
  const planResult = await client.prompt(sessionId, 'create-plan');
  assert.equal(planResult.stopReason, 'end_turn');
});

test('cancellation resolves a pending permission request and the prompt', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  let permissionStarted;
  const started = new Promise((resolve) => (permissionStarted = resolve));
  client.setClientRequestHandler(({ signal }) => {
    permissionStarted();
    return new Promise(() => signal.addEventListener('abort', () => {}, { once: true }));
  });

  const sessionId = await client.newSession(cwd);
  const prompt = client.prompt(sessionId, 'wait-permission');
  await started;
  await client.cancel(sessionId);
  const result = await prompt;
  assert.equal(result.stopReason, 'cancelled');
});

test('process exit rejects pending requests and clears them', async (t) => {
  const client = await startFake();
  t.after(() => client.close());
  const sessionId = await client.newSession(cwd);
  await assert.rejects(client.prompt(sessionId, 'exit'), /ACP process exited/);
});
