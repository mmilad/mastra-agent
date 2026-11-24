import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { AcpWorkerClient } from '../../src/integrations/acp/client.ts';
import { codexAcpLaunch, cursorAcpLaunch } from '../../src/integrations/acp/providers.ts';

const enabled = process.env.RUN_ACP_PROVIDER_TESTS === '1';
const cwd = tmpdir();

async function verifyProviderContract(launch) {
  const client = await AcpWorkerClient.start(launch);
  let responseText = '';
  client.events.on('update', ({ method, params }) => {
    if (method !== 'session/update') return;
    const update = params.update;
    if (update?.sessionUpdate === 'agent_message_chunk') {
      responseText += update.content?.text ?? '';
    }
  });
  try {
    const sessionId = await client.newSession(cwd);
    const result = await client.prompt(sessionId, 'Reply with exactly: ACP_CONTRACT_OK');
    assert.equal(result.stopReason, 'end_turn');
    assert.match(responseText, /ACP_CONTRACT_OK/);
    const supportsResume = client.capabilities.loadSession;
    client.close();

    if (supportsResume) {
      const resumedClient = await AcpWorkerClient.start(launch);
      let resumedText = '';
      resumedClient.events.on('update', ({ method, params }) => {
        if (method !== 'session/update') return;
        const update = params.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          resumedText += update.content?.text ?? '';
        }
      });
      try {
        await resumedClient.loadSession(sessionId, cwd);
        const resumed = await resumedClient.prompt(sessionId, 'Reply with exactly: ACP_RESUME_OK');
        assert.equal(resumed.stopReason, 'end_turn');
        assert.match(resumedText, /ACP_RESUME_OK/);
      } finally {
        resumedClient.close();
      }
    }
    return {
      responseText,
      stopReason: result.stopReason,
      capabilities: client.capabilities,
      resumed: supportsResume,
    };
  } finally {
    client.close();
  }
}

test('Cursor satisfies the common live ACP provider contract', { skip: !enabled }, async () => {
  const result = await verifyProviderContract(cursorAcpLaunch(cwd));
  assert.equal(typeof result.capabilities.loadSession, 'boolean');
});

test('Codex satisfies the common live ACP provider contract', { skip: !enabled }, async () => {
  const result = await verifyProviderContract(codexAcpLaunch(cwd));
  assert.equal(typeof result.capabilities.loadSession, 'boolean');
});
