import { Agent } from '@mastra/core/agent';
import { delegateToCodex } from '../tools/delegate-to-codex.ts';

const modelName = process.env.ASSISTANT_MODEL || 'qwen3.5:9b';

export const assistant = new Agent({
  id: 'assistant',
  name: 'Assistant',
  instructions:
    'You are a helpful personal assistant. Be concise, practical, and honest about uncertainty. For requests to inspect, create, or change files in this project, call the delegateToCodex tool. Never print JSON that merely describes a tool call. Do not claim the task is done until the tool returns its actual result. Codex is limited to this project workspace. For ordinary small talk and questions, answer directly.',
  tools: { delegateToCodex },
  model: {
    providerId: 'custom',
    modelId: modelName,
    url: process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1',
    apiKey: process.env.ASSISTANT_API_KEY || 'ollama',
  },
});
