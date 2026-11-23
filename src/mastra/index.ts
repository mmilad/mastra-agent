import { Mastra } from '@mastra/core';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistant } from './agents/assistant.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const observabilityStore = new DuckDBStore({
  id: 'assistant-observability',
  path: resolve(projectRoot, 'mastra-observability.duckdb'),
});

export const mastra = new Mastra({
  agents: { assistant },
  // Keep conversations in LibSQL and route Studio observability features to DuckDB.
  storage: new MastraCompositeStore({
    id: 'assistant-storage',
    default: new LibSQLStore({
      id: 'assistant-conversations',
      url: `file:${resolve(projectRoot, 'mastra.db')}`,
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
