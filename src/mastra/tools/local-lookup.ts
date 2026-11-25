import { open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { ScopedMemoryStore, type MemoryScope } from '../../context/memory-store.ts';
import { findWorkspaceRoot } from '../../context/scope.ts';

const allowedExtensions = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.gd', '.html', '.java', '.js', '.jsx',
  '.json', '.md', '.mdx', '.mjs', '.cjs', '.prisma', '.ps1', '.py', '.rs', '.scss', '.sh',
  '.sql', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml', '.svg', '.vue', '.svelte',
]);
const allowedExtensionless = new Set(['.gitignore', '.editorconfig', 'Dockerfile', 'Makefile']);
const excludedDirectories = new Set([
  '.git', '.mastra', '.next', '.turbo', '.venv', 'build', 'coverage', 'dist', 'node_modules',
  'out', 'target', 'vendor', 'venv', '.aws', '.ssh',
]);
const forbiddenName = /(^|[._-])(secret|secrets|credential|credentials|private[-_]?key|id_rsa|id_ed25519)([._-]|$)|^\.env(?!\.example$)|\.(pem|p12|pfx|key)$/i;
const maxReadBytes = 8000;
const maxFileBytes = 1024 * 1024;
const maxSearchFileBytes = 128 * 1024;
const maxSearchFiles = 500;
const maxSearchBytes = 8 * 1024 * 1024;
const duplicateSearchWindowMs = 30_000;
const recentProjectSearches = new Map<string, number>();

function recentSearchKey(threadId: string | undefined, query: string): string {
  return `${threadId ?? 'no-thread'}:${query.trim().toLocaleLowerCase()}`;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

function isAllowedFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (forbiddenName.test(name)) return false;
  return allowedExtensions.has(extname(name).toLowerCase()) || allowedExtensionless.has(name);
}

async function resolveProjectFile(projectRoot: string, projectPath: string): Promise<{ root: string; path: string; sourcePath: string }> {
  if (!projectPath.trim() || isAbsolute(projectPath)) throw new Error('Use a non-empty project-relative path.');
  const root = await realpath(resolve(projectRoot));
  const candidate = resolve(root, projectPath);
  if (!isWithin(root, candidate)) throw new Error('The requested path is outside the current project workspace.');
  const path = await realpath(candidate);
  if (!isWithin(root, path)) throw new Error('The requested path resolves outside the current project workspace.');
  if (!isAllowedFile(path)) throw new Error('This file type or filename is not available to project lookup.');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('The requested path is not a regular file.');
  if (info.size > maxFileBytes) throw new Error(`File is larger than the ${maxFileBytes}-byte read limit.`);
  return { root, path, sourcePath: relative(root, path).split(sep).join('/') };
}

export async function readProjectFile(input: {
  projectRoot: string;
  path: string;
  offset?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}) {
  if (input.signal?.aborted) throw new Error('Lookup cancelled.');
  const { root, path, sourcePath } = await resolveProjectFile(input.projectRoot, input.path);
  const offset = input.offset ?? 0;
  const byteLimit = input.maxBytes ?? maxReadBytes;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a non-negative byte position.');
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > maxReadBytes) {
    throw new Error(`maxBytes must be between 1 and ${maxReadBytes}.`);
  }
  const info = await stat(path);
  if (offset > info.size) throw new Error('offset is past the end of the file.');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, offset);
    if (input.signal?.aborted) throw new Error('Lookup cancelled.');
    const chunk = buffer.subarray(0, bytesRead);
    if (chunk.includes(0)) throw new Error('Binary files are not available to project lookup.');
    const nextOffset = offset + bytesRead;
    return {
      ok: true as const,
      source: { type: 'project-file' as const, path: sourcePath, startByte: offset, endByte: nextOffset },
      text: chunk.toString('utf8'),
      nextOffset: nextOffset < info.size ? nextOffset : null,
      truncated: nextOffset < info.size,
    };
  } finally {
    await handle.close();
  }
}

export async function searchProjectFiles(input: {
  projectRoot: string;
  query: string;
  offset?: number;
  limit?: number;
  signal?: AbortSignal;
}) {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length < 2) throw new Error('Search query must contain at least two characters.');
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 20;
  if (!Number.isInteger(offset) || offset < 0 || offset > 2000) throw new Error('offset must be between 0 and 2000.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('limit must be between 1 and 25.');

  const root = await realpath(resolve(input.projectRoot));
  const matches: Array<{ path: string; line: number; excerpt: string }> = [];
  let totalMatches = 0;
  let scannedFiles = 0;
  let scannedBytes = 0;
  let visitedEntries = 0;
  let incomplete = false;
  const issues: Array<{ path: string; reason: string }> = [];
  const deadline = Date.now() + 5000;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || scannedFiles >= maxSearchFiles || scannedBytes >= maxSearchBytes) {
      incomplete = true;
      return;
    }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      incomplete = true;
      if (issues.length < 5) issues.push({ path: relative(root, directory).split(sep).join('/') || '.', reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      visitedEntries += 1;
      if (input.signal?.aborted) throw new Error('Lookup cancelled.');
      if (Date.now() >= deadline) { incomplete = true; return; }
      if (visitedEntries > 5000) { incomplete = true; return; }
      if (scannedFiles >= maxSearchFiles || scannedBytes >= maxSearchBytes) { incomplete = true; return; }
      if (entry.isSymbolicLink()) continue;
      const fullPath = resolve(directory, entry.name);
      if (!isWithin(root, fullPath)) continue;
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isAllowedFile(fullPath)) continue;
      let fileInfo;
      try { fileInfo = await stat(fullPath); }
      catch (error) {
        incomplete = true;
        if (issues.length < 5) issues.push({ path: relative(root, fullPath).split(sep).join('/'), reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
        continue;
      }
      if (fileInfo.size > maxSearchFileBytes) {
        incomplete = true;
        if (issues.length < 5) issues.push({ path: relative(root, fullPath).split(sep).join('/'), reason: `Skipped file larger than ${maxSearchFileBytes} bytes.` });
        continue;
      }
      if (fileInfo.size === 0) continue;
      const remaining = maxSearchBytes - scannedBytes;
      const bytesToRead = Math.min(fileInfo.size, remaining);
      if (bytesToRead <= 0) { incomplete = true; return; }
      let content: string;
      try {
        const handle = await open(fullPath, 'r');
        try {
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
          const chunk = buffer.subarray(0, bytesRead);
          if (chunk.includes(0)) continue;
          content = chunk.toString('utf8');
          scannedBytes += bytesRead;
          scannedFiles += 1;
        } finally { await handle.close(); }
      } catch (error) {
        incomplete = true;
        if (issues.length < 5) issues.push({ path: relative(root, fullPath).split(sep).join('/'), reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
        continue;
      }
      const sourcePath = relative(root, fullPath).split(sep).join('/');
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].toLocaleLowerCase().includes(query)) continue;
        if (totalMatches >= offset && matches.length < limit) {
          matches.push({ path: sourcePath, line: index + 1, excerpt: lines[index].trim().slice(0, 300) });
        }
        totalMatches += 1;
      }
    }
  };

  await visit(root, 0);
  const pageHasMore = totalMatches > offset + matches.length;
  return {
    ok: true as const,
    query: input.query.trim(),
    matches,
    totalMatches,
    nextOffset: pageHasMore ? offset + matches.length : null,
    scannedFiles,
    scannedBytes,
    incomplete,
    issues,
    source: { type: 'project-search' as const, root },
  };
}

export async function lookupScopedMemory(input: {
  projectRoot: string;
  scope: MemoryScope;
  query?: string;
  offset?: number;
  limit?: number;
  databasePath?: string;
  store?: Pick<ScopedMemoryStore, 'list'> & Partial<Pick<ScopedMemoryStore, 'close'>>;
}) {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 5;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000) throw new Error('offset must be between 0 and 1000.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('limit must be between 1 and 5.');
  const store = input.store ?? new ScopedMemoryStore({ projectRoot: input.projectRoot, databasePath: input.databasePath });
  try {
    const records = await store.list({ scope: input.scope, query: input.query?.trim() || undefined });
    const page = records.slice(offset, offset + limit).map(record => ({
      id: record.id,
      scope: record.scope,
      kind: record.kind,
      key: record.key,
      value: record.value.slice(0, 1200),
      valueTruncated: record.value.length > 1200,
      source: record.source,
      sourceId: record.sourceId,
      revision: record.revision,
    }));
    return {
      ok: true as const,
      scope: input.scope,
      query: input.query?.trim() || null,
      records: page,
      totalMatches: records.length,
      nextOffset: records.length > offset + page.length ? offset + page.length : null,
      sources: page.map(record => ({ type: 'memory' as const, id: record.id, scope: record.scope, key: record.key })),
    };
  } finally {
    await store.close?.();
  }
}

const localLookup = createTool({
  id: 'local-project-lookup',
  description: 'Search and read allowlisted text files in the current project. All paths are project-relative; results include source paths and bounded follow-up offsets. Never infer file contents when the tool reports an error or incomplete search.',
  inputSchema: z.object({
    operation: z.enum(['search', 'read']),
    query: z.string().min(2).max(200).optional(),
    path: z.string().max(500).optional(),
    offset: z.number().int().min(0).max(2000).optional(),
    limit: z.number().int().min(1).max(25).optional(),
    maxBytes: z.number().int().min(1).max(maxReadBytes).optional(),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string(), data: z.string().optional() }),
  execute: async (input, context) => {
    const projectRoot = findWorkspaceRoot();
    try {
      if (input.operation === 'search') {
        if (!input.query) return { ok: false, message: 'A search query is required.' };
        const searchKey = recentSearchKey(
          typeof context?.agent?.threadId === 'string' ? context.agent.threadId : undefined,
          input.query,
        );
        const lastSearchAt = recentProjectSearches.get(searchKey);
        const now = Date.now();
        if (lastSearchAt && now - lastSearchAt < duplicateSearchWindowMs) {
          return {
            ok: false,
            message:
              'This exact search was already run in the last 30 seconds. Summarize the earlier results for the user instead of searching again.',
          };
        }
        recentProjectSearches.set(searchKey, now);
        const result = await searchProjectFiles({ projectRoot, query: input.query, offset: input.offset, limit: input.limit, signal: context?.abortSignal });
        return { ok: true, message: result.incomplete ? 'Search reached its safety scan limit; results may be incomplete.' : `${result.totalMatches} match(es) found.`, data: JSON.stringify(result) };
      }
      if (!input.path) return { ok: false, message: 'A project-relative file path is required.' };
      const result = await readProjectFile({ projectRoot, path: input.path, offset: input.offset, maxBytes: input.maxBytes, signal: context?.abortSignal });
      return { ok: true, message: result.truncated ? `Read ${result.source.path} partially; continue at byte offset ${result.nextOffset}.` : `Read ${result.source.path}.`, data: JSON.stringify(result) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
});

const memoryLookup = createTool({
  id: 'scoped-memory-lookup',
  description: 'Read active user preferences or current-project facts from local memory. Always choose the exact scope; results are bounded and cite memory record IDs. This tool cannot write or forget memory.',
  inputSchema: z.object({
    scope: z.enum(['user', 'project']),
    query: z.string().max(200).optional(),
    offset: z.number().int().min(0).max(1000).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  }),
  outputSchema: z.object({ ok: z.boolean(), message: z.string(), data: z.string().optional() }),
  execute: async input => {
    const projectRoot = findWorkspaceRoot();
    try {
      const result = await lookupScopedMemory({ projectRoot, scope: input.scope, query: input.query, offset: input.offset, limit: input.limit });
      return { ok: true, message: `${result.totalMatches} ${input.scope} memory record(s) match.`, data: JSON.stringify(result) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const localProjectLookup = localLookup;
export const scopedMemoryLookup = memoryLookup;
