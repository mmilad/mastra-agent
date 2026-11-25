import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { KNOWLEDGE_ROUTES } from '@mastra/server/server-adapter';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assistantDatabasePath } from '../context/scope.ts';
import { createAssistant } from './agents/assistant.ts';
import { bootstrapSignals } from '../signals/bootstrap.ts';
import { LocalFilesystem, Workspace } from '@mastra/core/workspace';
import { projectKnowledge } from '../knowledge/project-knowledge.ts';
import { knowledgeAnswer } from './workflows/knowledge-answer.ts';

const projectRoot = dirname(assistantDatabasePath());
const observabilityStore = new DuckDBStore({
  id: 'assistant-observability',
  path: resolve(projectRoot, 'mastra-observability.duckdb'),
});

const conversationStore = new LibSQLStore({
  id: 'assistant-conversations',
  url: pathToFileURL(assistantDatabasePath()).href,
});
await conversationStore.init();
const notifications = await conversationStore.getStore('notifications');
const assistant = createAssistant(notifications ? { notifications } : {});

export const mastra = new Mastra({
  agents: { assistant },
  workflows: { knowledgeAnswer },
  knowledge: { projectDocs: projectKnowledge },
  // Read-only workspace over the parent folder of this project, so all sibling projects are visible.
  // Override with PLANTOOL_WORKSPACE. contained: false is needed because Mastra's containment check
  // rejects every file on Windows; the agent can then read paths outside the base folder.
  workspace: new Workspace({
    filesystem: new LocalFilesystem({
      basePath: process.env.PLANTOOL_WORKSPACE || resolve(projectRoot, '..'),
      readOnly: true,
      contained: false,
    }),
  }),
  // Studio's Knowledge browser needs these routes; they list Knowledge instances registered here.
  server: { apiRoutes: [...KNOWLEDGE_ROUTES] },
  // Keep conversations in LibSQL and route Studio observability features to DuckDB.
  storage: new MastraCompositeStore({
    id: 'assistant-storage',
    default: conversationStore,
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

bootstrapSignals(mastra);
