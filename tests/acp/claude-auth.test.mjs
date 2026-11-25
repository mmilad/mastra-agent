import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { assertClaudeWorkerAuth } from '../../src/integrations/acp/claude-auth.ts';

test('bundled Claude CLI path resolves on this platform', async () => {
  if (process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_API_KEY?.trim()) return;
  try {
    await assertClaudeWorkerAuth();
  } catch (error) {
    assert.match(String(error), /not logged in|ANTHROPIC_API_KEY|Could not read Claude login status|Command failed/);
  }
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const path = createRequire(join(process.cwd(), 'package.json')).resolve(
    `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/${binary}`,
  );
  assert.equal(existsSync(path), true);
});