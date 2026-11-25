import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { AcpWorkerClient } from '../../src/integrations/acp/client.ts';
import { claudeAcpLaunch, codexAcpLaunch, cursorAcpLaunch } from '../../src/integrations/acp/providers.ts';

const enabled = process.env.RUN_ACP_PROVIDER_TESTS === '1';
const cwd = tmpdir();

test('Cursor launch uses the sandboxed ACP command in the selected workspace', () => {
  const launch = cursorAcpLaunch(cwd);
  const expectedCommand = process.env.CURSOR_AGENT_COMMAND ?? 'agent';
  if (process.env.CURSOR_AGENT_COMMAND) {
    assert.equal(launch.command, expectedCommand);
  } else if (process.platform === 'win32') {
    assert.match(launch.command, /[/\\]agent(\.cmd)?$/i);
  } else {
    assert.equal(launch.command, expectedCommand);
  }
  assert.deepEqual(launch.args, ['--sandbox', 'enabled', 'acp']);
  assert.equal(launch.cwd, cwd);
});

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

test('Claude launch runs the packaged ACP adapter with Node', () => {
  const launch = claudeAcpLaunch(cwd);
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /claude-agent-acp[/\\]dist[/\\]index\.js$/);
  assert.equal(launch.cwd, cwd);
});

test('Cursor satisfies the common live ACP provider contract', { skip: !enabled }, async () => {
  const result = await verifyProviderContract(cursorAcpLaunch(cwd));
  assert.equal(typeof result.capabilities.loadSession, 'boolean');
});

test('Claude satisfies the common live ACP provider contract', { skip: !enabled }, async () => {
  const result = await verifyProviderContract(claudeAcpLaunch(cwd));
  assert.equal(typeof result.capabilities.loadSession, 'boolean');
});

test('Codex satisfies the common live ACP provider contract', { skip: !enabled }, async () => {
  const result = await verifyProviderContract(codexAcpLaunch(cwd));
  assert.equal(typeof result.capabilities.loadSession, 'boolean');
});
