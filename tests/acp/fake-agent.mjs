import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let promptRequestId;
let permissionRequestId;
let nextServerRequest = 100;

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });

input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: process.env.FAKE_LOAD_SESSION === 'true',
        sessionCapabilities: { list: {} },
      },
      authMethods: [{ id: 'fake-auth', name: 'Fake Auth' }],
    });
    return;
  }
  if (message.method === 'session/new') {
    reply(message.id, { sessionId: 'fake-session' });
    return;
  }
  if (message.method === 'session/load') {
    reply(message.id, { sessionId: message.params.sessionId });
    return;
  }
  if (message.method === 'session/cancel') {
    if (promptRequestId !== undefined) {
      reply(promptRequestId, { sessionId: 'fake-session', stopReason: 'cancelled' });
      promptRequestId = undefined;
    }
    return;
  }
  if (message.method === 'session/prompt') {
    promptRequestId = message.id;
    const text = message.params.prompt[0].text;
    if (text === 'exit') {
      process.exit(3);
    }
    if (text === 'wait-permission') {
      permissionRequestId = nextServerRequest++;
      send({
        jsonrpc: '2.0',
        id: permissionRequestId,
        method: 'session/request_permission',
        params: {
          sessionId: 'fake-session',
          title: 'Allow write?',
          options: [{ optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
        },
      });
      return;
    }
    if (text === 'unknown-request') {
      permissionRequestId = nextServerRequest++;
      send({ jsonrpc: '2.0', id: permissionRequestId, method: 'provider/unknown_blocking', params: {} });
      return;
    }
    if (text === 'create-plan') {
      permissionRequestId = nextServerRequest++;
      send({
        jsonrpc: '2.0',
        id: permissionRequestId,
        method: 'cursor/create_plan',
        params: { sessionId: 'fake-session', plan: 'A disposable test plan', todos: [] },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE_OK' } },
      },
    });
    reply(promptRequestId, { sessionId: 'fake-session', stopReason: 'end_turn' });
    promptRequestId = undefined;
    return;
  }
  if (message.id === permissionRequestId) {
    if (message.error?.code === -32601) {
      reply(promptRequestId, { sessionId: 'fake-session', stopReason: 'end_turn' });
      promptRequestId = undefined;
      permissionRequestId = undefined;
      return;
    }
    if (message.result?.outcome?.outcome === 'cancelled') {
      reply(promptRequestId, { sessionId: 'fake-session', stopReason: 'end_turn' });
      promptRequestId = undefined;
      permissionRequestId = undefined;
    }
  }
});
