import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function moduleRequire() {
  // Mastra bundles tool code under `.mastra/output/`; anchor resolution at the project root.
  return createRequire(join(process.cwd(), 'package.json'));
}

function bundledClaudeExecutable(): string {
  const configured = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured) return configured;
  const require = moduleRequire();
  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  return require.resolve(`${packageName}/${binary}`);
}

/** Ensure the Claude worker can authenticate before spawning the ACP adapter. */
export async function assertClaudeWorkerAuth(): Promise<void> {
  if ([process.env.ANTHROPIC_API_KEY, process.env.CLAUDE_API_KEY].some((value) => value?.trim())) return;

  const claudeExecutable = bundledClaudeExecutable();
  if (!existsSync(claudeExecutable)) {
    throw new Error(
      'Claude worker binary was not found. Reinstall dependencies or set CLAUDE_CODE_EXECUTABLE to a Claude Code CLI.',
    );
  }

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(claudeExecutable, ['auth', 'status'], {
      timeout: 15_000,
      windowsHide: true,
    }));
  } catch (error) {
  // Claude Code prints JSON on stdout but exits 1 when loggedIn is false.
    const failed = error as NodeJS.ErrnoException & { stdout?: string };
    if (failed.stdout?.trim()) stdout = failed.stdout;
    else throw new Error('Could not read Claude login status. Set ANTHROPIC_API_KEY in .env or run `claude auth login`.');
  }
  let status: { loggedIn?: boolean };
  try {
    status = JSON.parse(stdout) as { loggedIn?: boolean };
  } catch {
    throw new Error('Could not read Claude login status. Set ANTHROPIC_API_KEY in .env or run `claude auth login`.');
  }
  if (status.loggedIn !== true) {
    throw new Error(
      'Claude worker is not logged in. Set ANTHROPIC_API_KEY in .env or run `claude auth login` in a terminal, then retry.',
    );
  }
}