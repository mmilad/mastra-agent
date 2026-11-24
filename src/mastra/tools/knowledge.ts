import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findWorkspaceRoot } from '../../context/scope.ts';
import { knowledgeDatabaseUrl, searchKnowledge } from '../../knowledge/index-store.ts';

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export async function searchProjectKnowledge(query: string, topK: number) {
  return searchKnowledge({
    projectRoot: findWorkspaceRoot(),
    databaseUrl: knowledgeDatabaseUrl(applicationRoot),
    query,
    topK,
  });
}

export const knowledgeSearch = createTool({
  id: 'knowledge-search',
  description:
    'Semantic search over the indexed project documentation (README.md and docs/**/*.md). Returns passages with their source path and a similarity score. Cite the source path when you use a passage.',
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    topK: z.number().int().min(1).max(10).default(5),
  }),
  execute: async ({ query, topK }) => {
    const passages = await searchProjectKnowledge(query, topK);
    return { passages };
  },
});
