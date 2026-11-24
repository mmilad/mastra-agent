import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Knowledge, knowledgeMemoryScopes } from '@mastra/core/knowledge';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { projectScopeId } from '../context/scope.ts';
import { createOllamaEmbedder } from './embedder.ts';

const applicationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// One local database holds Knowledge pages and their vectors. It is separate from the
// conversation and observability stores so that the Studio's DuckDB file stays unaffected.
export const knowledgeDatabasePath = resolve(applicationRoot, 'knowledge.db');
const knowledgeDatabaseUrl = `file:${knowledgeDatabasePath.split(sep).join('/')}`;

export const projectKnowledgeId = 'project-docs';

// Each workspace gets its own scope, so the pages of one project never leak into another.
export function workspaceScopeAddress(projectRoot: string): string {
  return `workspace:${projectScopeId(projectRoot)}`;
}

export const projectKnowledge = new Knowledge({
  id: projectKnowledgeId,
  name: 'Project documentation',
  description: 'README.md and Markdown files under docs/ of the workspace the assistant is working in.',
  storage: new LibSQLStore({ id: 'knowledge-storage', url: knowledgeDatabaseUrl }),
  vector: new LibSQLVector({ id: 'knowledge-vector', url: knowledgeDatabaseUrl }),
  embedder: createOllamaEmbedder(),
  scopes: {
    ...knowledgeMemoryScopes({ org: false }),
    'workspace:$workspaceId': {
      description: 'Documentation pages of one workspace, synced from its README.md and docs/ folder.',
      displayLabel: 'Workspace',
      access: [{ principal: 'self', role: 'viewer' }],
    },
  },
  tools: { read: true },
});
