import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { LibSQLVector } from '@mastra/libsql';
import { MDocument } from '@mastra/rag';
import { projectScopeId } from '../context/scope.ts';
import { documentPrefix, embeddingDimension, embedTexts, queryPrefix } from './embedder.ts';

// Knowledge chunks live in their own database next to the assistant's other local stores.
// Each workspace gets its own index so that rebuilding one never touches another.
export function knowledgeDatabaseUrl(applicationRoot: string): string {
  // LibSQLVector reads "file:" URLs as plain paths, so use the absolute path rather than a file:// URL.
  return `file:${resolve(applicationRoot, 'knowledge.db').split(sep).join('/')}`;
}

export function knowledgeIndexName(projectRoot: string): string {
  return `k_${projectScopeId(projectRoot)}`;
}

export interface KnowledgePassage {
  source: string;
  score: number;
  text: string;
}

const maxFileBytes = 512 * 1024;

// Indexed sources: README.md and Markdown files under docs/ of the workspace.
export async function collectKnowledgeSources(projectRoot: string): Promise<{ path: string; source: string }[]> {
  const sources: { path: string; source: string }[] = [];
  sources.push({ path: resolve(projectRoot, 'README.md'), source: 'README.md' });
  const docsRoot = resolve(projectRoot, 'docs');
  try {
    const entries = await readdir(docsRoot, { recursive: true, withFileTypes: false });
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

export async function buildKnowledgeIndex(input: {
  projectRoot: string;
  databaseUrl: string;
}): Promise<{ files: number; chunks: number; indexName: string }> {
  const indexName = knowledgeIndexName(input.projectRoot);
  const vector = new LibSQLVector({ id: 'knowledge-index', url: input.databaseUrl });

  const chunks: { text: string; metadata: Record<string, string | number> }[] = [];
  let files = 0;
  for (const { path, source } of await collectKnowledgeSources(input.projectRoot)) {
    let text: string;
    try {
      const info = await readFile(path);
      if (info.byteLength > maxFileBytes) continue;
      text = info.toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    files += 1;
    const document = MDocument.fromMarkdown(text, { source });
    await document.chunk({ strategy: 'markdown', maxSize: 1000, overlap: 100 });
    for (const chunk of document.getDocs()) {
      if (chunk.text.trim()) chunks.push({ text: chunk.text, metadata: { source, text: chunk.text } });
    }
  }

  // Rebuild from scratch: simpler and always consistent with the current files.
  try {
    await vector.deleteIndex({ indexName });
  } catch {
    // The index did not exist yet.
  }
  await vector.createIndex({ indexName, dimension: embeddingDimension, metric: 'cosine' });
  if (chunks.length > 0) {
    const vectors = await embedTexts(chunks.map((chunk) => chunk.text), documentPrefix);
    await vector.upsert({ indexName, vectors, metadata: chunks.map((chunk) => chunk.metadata) });
  }
  return { files, chunks: chunks.length, indexName };
}

export async function searchKnowledge(input: {
  projectRoot: string;
  databaseUrl: string;
  query: string;
  topK: number;
}): Promise<KnowledgePassage[]> {
  const indexName = knowledgeIndexName(input.projectRoot);
  const vector = new LibSQLVector({ id: 'knowledge-index', url: input.databaseUrl });
  const [queryVector] = await embedTexts([input.query], queryPrefix);
  if (!queryVector) return [];
  let results;
  try {
    results = await vector.query({ indexName, queryVector, topK: input.topK });
  } catch (error) {
    throw new Error(`Knowledge index unavailable. Run "npm run knowledge:index" first. (${(error as Error).message})`);
  }
  return results.map((result) => ({
    source: String(result.metadata?.source ?? 'unknown'),
    score: Number(result.score.toFixed(4)),
    text: String(result.metadata?.text ?? ''),
  }));
}
