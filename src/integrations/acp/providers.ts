import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { AcpLaunch } from './client.ts';

export const acpWorkers = ['codex', 'cursor', 'claude'] as const;
export type AcpWorker = (typeof acpWorkers)[number];

function resolveWindowsCommand(command: string): string {
  if (process.platform !== 'win32') return command;

  const extensions = extname(command)
    ? ['']
    : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';');
  const hasDirectory = command.includes('/') || command.includes('\\');
  const directories = hasDirectory ? [''] : (process.env.PATH ?? '').split(delimiter);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasDirectory
        ? `${command}${extension}`
        : join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/** True when PATH resolved to the Cursor editor instead of the Agent CLI (opens bogus tabs like agent/acp/enabled). */
export function isLikelyCursorIdeBinary(command: string): boolean {
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/cursor-agent/')) return false;
  return (
    normalized.includes('/cursor/resources/')
    || normalized.includes('/programs/cursor/')
    || /[/\\]cursor\.(cmd|exe)$/i.test(command)
    || /[/\\]cli\.js$/i.test(command)
  );
}

export function defaultCursorAgentCommand(): string {
  const configured = process.env.CURSOR_AGENT_COMMAND?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    const agentCmd = join(local, 'cursor-agent', 'agent.cmd');
    if (existsSync(agentCmd)) return agentCmd;
  }
  return 'agent';
}

export function resolveCursorAgentCommand(): string {
  const command = resolveWindowsCommand(defaultCursorAgentCommand());
  if (isLikelyCursorIdeBinary(command)) {
    throw new Error(
      'Cursor worker launch resolved to the Cursor editor, not the Agent CLI. '
      + 'Set CURSOR_AGENT_COMMAND to your agent.cmd (for example %LOCALAPPDATA%\\cursor-agent\\agent.cmd).',
    );
  }
  return command;
}

function packagedAdapterLaunch(
  cwd: string,
  packageName: string,
  entry = 'dist/index.js',
  env: NodeJS.ProcessEnv = process.env,
): AcpLaunch {
  const packageJson = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const adapterPath = join(dirname(packageJson), entry);
  return { command: process.execPath, args: [adapterPath], cwd, env: { ...env } };
}

/** Codex ACP runs through the maintained adapter and inherits the existing login. */
export function codexAcpLaunch(cwd: string): AcpLaunch {
  return packagedAdapterLaunch(cwd, '@agentclientprotocol/codex-acp', 'dist/index.js', {
    ...process.env,
    INITIAL_AGENT_MODE: 'workspace-write',
    NO_BROWSER: '1',
  });
}

/** Claude Agent SDK via the maintained ACP adapter (Anthropic API key or Claude Code login). */
export function claudeAcpLaunch(cwd: string): AcpLaunch {
  return packagedAdapterLaunch(cwd, '@agentclientprotocol/claude-agent-acp');
}

/** Cursor Agent CLI ACP server; sandboxed to the workspace unless permissions are granted. */
export function cursorAcpLaunch(cwd: string): AcpLaunch {
  const command = resolveCursorAgentCommand();
  return {
    command,
    args: ['--sandbox', 'enabled', 'acp'],
    cwd,
    ...(process.platform === 'win32' && /\.(cmd|bat)$/i.test(command) ? { shell: true } : {}),
  };
}

export function workerAcpLaunch(worker: AcpWorker, cwd: string): AcpLaunch {
  switch (worker) {
    case 'cursor':
      return cursorAcpLaunch(cwd);
    case 'claude':
      return claudeAcpLaunch(cwd);
    default:
      return codexAcpLaunch(cwd);
  }
}
