import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { KNOWLEDGE_ROUTES } from '@mastra/server/server-adapter';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assistantDatabasePath } from '../context/scope.ts';
import { assistant } from './agents/assistant.ts';
import { projectKnowledge } from '../knowledge/project-knowledge.ts';
import { knowledgeAnswer } from './workflows/knowledge-answer.ts';

const projectRoot = dirname(assistantDatabasePath());
const observabilityStore = new DuckDBStore({
  id: 'assistant-observability',
  path: resolve(projectRoot, 'mastra-observability.duckdb'),
});

export const mastra = new Mastra({
  agents: { assistant },
  workflows: { knowledgeAnswer },
  knowledge: { projectDocs: projectKnowledge },
  // Studio's Knowledge browser needs these routes; they list Knowledge instances registered here.
  server: { apiRoutes: [...KNOWLEDGE_ROUTES] },
  // Keep conversations in LibSQL and route Studio observability features to DuckDB.
  storage: new MastraCompositeStore({
    id: 'assistant-storage',
    default: new LibSQLStore({
      id: 'assistant-conversations',
      url: pathToFileURL(assistantDatabasePath()).href,
    }),
    domains: {
      observability: observabilityStore.observability,
    },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra-assistant',
        exporters: [new MastraStorageExporter()],
        logging: { enabled: true, level: 'info' },
      },
    },
  }),
});
