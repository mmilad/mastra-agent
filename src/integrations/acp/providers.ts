import { fileURLToPath } from 'node:url';
import type { AcpLaunch } from './client.ts';

/** Codex ACP runs through the maintained adapter and inherits the existing login. */
export function codexAcpLaunch(cwd: string): AcpLaunch {
  const adapterPath = fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp'));
  return {
    command: process.execPath,
    args: [adapterPath],
    cwd,
    env: { ...process.env, INITIAL_AGENT_MODE: 'workspace-write', NO_BROWSER: '1' },
  };
}

/** Cursor ACP is sandboxed to the selected workspace unless permissions are granted. */
export function cursorAcpLaunch(cwd: string): AcpLaunch {
  return {
    command: process.env.CURSOR_AGENT_COMMAND ?? 'cursor',
    args: ['agent', '--sandbox', 'enabled', 'acp'],
    cwd,
  };
}
