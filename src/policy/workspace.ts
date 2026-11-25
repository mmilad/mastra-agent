import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

export type PermissionScope = {
  fingerprint: string;
  operation: string;
  summary: string;
  inWorkspace: boolean;
  automaticallyAllowed: boolean;
  reason?: string;
};

function canonicalPath(value: string, base: string): string {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
  const absolute = resolve(base, expanded);
  let current = absolute;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...tail);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..`) && !isAbsolute(pathFromRoot));
}

function collectPaths(value: unknown, paths: string[] = [], key = ''): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, key);
  } else if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) collectPaths(child, paths, childKey);
  } else if (
    typeof value === 'string' &&
    /^(path|filePath|file_path|targetPath|target_path)$/i.test(key)
  ) {
    paths.push(value);
  }
  return paths;
}

function isWindowsReadCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/[;&<>`$\n\r]/.test(trimmed)) return false;
  const segments = trimmed.split('|').map((segment) => segment.trim());
  if (segments.length === 0) return false;
  const allowed = [/^(Get-Item|Test-Path|Get-Content)\b/i, /^Select-Object\b/i];
  return segments.every((segment) => allowed.some((pattern) => pattern.test(segment)));
}

function isAllowedCommand(command: string): boolean {
  if (isWindowsReadCommand(command)) return true;
  // Requests are command strings rather than an argv array. Refuse shell syntax
  // so a seemingly safe first command cannot conceal a second operation.
  if (/[;|&<>`$\n\r'"\\~*?\[\]{}()]/.test(command)) return false;
  const tokens = command.trim().split(/\s+/);
  const executable = tokens.shift()?.split('/').at(-1);
  if (!executable) return false;
  if (['pwd', 'ls', 'cat', 'head', 'tail', 'sed', 'rg', 'grep'].includes(executable)) return true;
  if (executable === 'git') {
    return ['status', 'diff', 'log', 'show', 'rev-parse'].includes(tokens[0] ?? '');
  }
  if (executable === 'npm') {
    return tokens.length === 2 && tokens[0] === 'run' && ['check', 'test:acp', 'test:policy'].includes(tokens[1] ?? '');
  }
  return false;
}

export function inspectPermissionRequest(projectRoot: string, method: string, params: Record<string, unknown>): PermissionScope {
  const root = canonicalPath(projectRoot, projectRoot);
  const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
  const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'unknown';
  const title = typeof toolCall.title === 'string' ? toolCall.title : 'ACP permission request';
  const command = typeof rawInput.command === 'string' ? rawInput.command.trim() : '';
  const cwdValue = typeof rawInput.cwd === 'string' ? rawInput.cwd : projectRoot;
  const cwd = canonicalPath(cwdValue, projectRoot);
  const paths = collectPaths(rawInput);
  paths.push(...collectPaths(toolCall.content));
  if (command) {
    // Treat path-like command arguments and option values as part of the scope.
    for (const token of command.trim().split(/\s+/)) {
      const candidate = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
      if (
        !candidate.startsWith('-') &&
        (candidate.startsWith('/') || candidate.startsWith('~/') || candidate.startsWith('./') || candidate.startsWith('../') || candidate.includes('/'))
      ) {
        paths.push(candidate);
      }
    }
  }
  const canonicalPaths = [...new Set(paths.map((path) => canonicalPath(path, cwd)))].sort();
  const inWorkspace = isWithin(root, cwd) && canonicalPaths.every((path) => isWithin(root, path));
  const supportedKind = ['edit', 'write', 'create', 'delete', 'execute', 'read'].includes(kind);
  const commandAllowed = kind !== 'execute' || (command.length > 0 && isAllowedCommand(command));
  const hasOperationTarget = kind === 'execute' ? command.length > 0 : canonicalPaths.length > 0;
  const consequential = kind === 'delete';
  const automaticallyAllowed = method === 'session/request_permission' && supportedKind && hasOperationTarget && inWorkspace && commandAllowed && !consequential;
  const operation = kind === 'execute' ? `execute: ${command || title}` : `${kind}: ${canonicalPaths.join(', ') || title}`;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ method, kind, command, cwd, paths: canonicalPaths, content: toolCall.content ?? null, rawInput }))
    .digest('hex');

  return {
    fingerprint,
    operation,
    summary: `${title}${canonicalPaths.length ? ` (${canonicalPaths.join(', ')})` : ''}${command ? ` — ${command}` : ''}`,
    inWorkspace,
    automaticallyAllowed,
    ...(!supportedKind ? { reason: `Unsupported operation kind: ${kind}` } : {}),
    ...(supportedKind && !inWorkspace ? { reason: 'The requested path or working directory is outside the authorized project workspace.' } : {}),
    ...(supportedKind && inWorkspace && !commandAllowed ? { reason: 'This command is outside the automatic command allowlist.' } : {}),
    ...(supportedKind && !hasOperationTarget ? { reason: 'The provider request did not include a verifiable operation target.' } : {}),
    ...(consequential ? { reason: 'File deletion is consequential and requires approval.' } : {}),
  };
}

export function taskFingerprint(task: string): string {
  return createHash('sha256').update(task).digest('hex');
}

export function choosePermissionOption(params: Record<string, unknown>, allow: boolean): Record<string, unknown> {
  const options = Array.isArray(params.options) ? params.options as Record<string, unknown>[] : [];
  const acceptedKinds = allow ? ['allow_once', 'allow-once'] : ['reject_once', 'reject-once'];
  const option = options.find((item) => typeof item.kind === 'string' && acceptedKinds.includes(item.kind));
  if (typeof option?.optionId !== 'string') {
    return { outcome: { outcome: allow ? 'cancelled' : 'cancelled' } };
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}
