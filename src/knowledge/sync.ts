import { readFile, readdir } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { projectKnowledge, workspaceScopeAddress } from './project-knowledge.ts';

const maxFileBytes = 512 * 1024;

export interface KnowledgeSource {
  path: string;
  source: string;
}

// Indexed sources: README.md and Markdown files under docs/ of the workspace.
export async function collectKnowledgeSources(projectRoot: string): Promise<KnowledgeSource[]> {
  const sources: KnowledgeSource[] = [{ path: resolve(projectRoot, 'README.md'), source: 'README.md' }];
  const docsRoot = resolve(projectRoot, 'docs');
  try {
    const entries = await readdir(docsRoot, { recursive: true });
    for (const entry of entries) {
      if (!String(entry).toLowerCase().endsWith('.md')) continue;
      const path = resolve(docsRoot, String(entry));
      sources.push({ path, source: `docs/${relative(docsRoot, path).split(sep).join('/')}` });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return sources;
}

// Knowledge page keys are flat here: one key per file, so stale pages can be removed as leaves.
export function pageKeyFor(source: string): string {
  return source
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function pageNameFor(source: string, text: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || basename(source);
}

export async function syncProjectKnowledge(projectRoot: string): Promise<{ written: number; unchanged: number; removed: number }> {
  const scope = workspaceScopeAddress(projectRoot);
  const keys = new Set<string>();
  let written = 0;
  let unchanged = 0;
  let scopeId: string | undefined;

  for (const { path, source } of await collectKnowledgeSources(projectRoot)) {
    let text: string;
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > maxFileBytes) continue;
      text = bytes.toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const key = pageKeyFor(source);
    keys.add(key);
    const result = await projectKnowledge.upsertPage({
      scope,
      path: key,
      name: pageNameFor(source, text),
      body: text,
      author: 'sync',
    });
    scopeId ??= result.page.scopeId;
    if (result.status === 'unchanged') unchanged += 1;
    else written += 1;
  }

  // Remove pages whose source file is gone. Only pages in this workspace's scope are touched.
  let removed = 0;
  if (scopeId) {
    const storage = await projectKnowledge.getStorage();
    let cursor: string | undefined;
    do {
      const page = await storage.listPages({ read: 'all', cursor, limit: 200 });
      for (const candidate of page.pages) {
        if (candidate.isScope || candidate.scopeId !== scopeId || !candidate.key) continue;
        if (keys.has(candidate.key)) continue;
        await projectKnowledge.removePage({ scope, path: candidate.key, author: 'sync' });
        removed += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return { written, unchanged, removed };
}
