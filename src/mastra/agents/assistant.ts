import { Agent } from '@mastra/core/agent';

export const assistant = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions:
    'You are a helpful personal assistant. Be concise, practical, and honest about uncertainty. You have no tools and cannot perform actions outside this conversation.',
  model: process.env.MASTRA_MODEL || 'openai/gpt-4.1-mini',
});
