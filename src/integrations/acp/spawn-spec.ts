import type { AcpLaunch } from './client.ts';

export type AcpSpawnSpec = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/** Build a Windows cmd.exe invocation for .cmd/.bat launchers without losing paths with spaces. */
export function acpSpawnSpec(launch: AcpLaunch, args = launch.args): AcpSpawnSpec {
  if (process.platform !== 'win32' || !launch.shell) {
    return { command: launch.command, args };
  }

  if (launch.command.includes('"') || args.some((arg) => /["&|<>\r\n]/.test(arg))) {
    throw new Error('Unsafe argument in Windows batch worker command.');
  }

  const commandLine = `""${launch.command}" ${args.join(' ')}"`;
  return {
    command: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', commandLine],
    windowsVerbatimArguments: true,
  };
}
