import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function assistantDatabasePath(): string {
  return resolve(applicationRoot, 'mastra.db');
}

export function findWorkspaceRoot(start = process.env.ASSISTANT_PROJECT_ROOT || process.cwd()): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(resolve(current, '.git')) || existsSync(resolve(current, '.plan'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function projectScopeId(projectRoot = findWorkspaceRoot()): string {
  return createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 24);
}

export function projectResourceId(projectRoot = findWorkspaceRoot()): string {
  return `local-user:project:${projectScopeId(projectRoot)}`;
}
