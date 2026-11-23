import { Agent } from '@mastra/core/agent';

const modelName = process.env.ASSISTANT_MODEL || 'llama3';

export const assistant = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions:
    'You are a helpful personal assistant. Be concise, practical, and honest about uncertainty. You have no tools and cannot perform actions outside this conversation.',
  model: {
    providerId: 'custom',
    modelId: modelName,
    url: process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1',
    apiKey: process.env.ASSISTANT_API_KEY || 'ollama',
  },
});
