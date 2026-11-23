import { Mastra } from '@mastra/core';
import { assistant } from './agents/assistant.ts';

export const mastra = new Mastra({
  agents: { assistant },
});
