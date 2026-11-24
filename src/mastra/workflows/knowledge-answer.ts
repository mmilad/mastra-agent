import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { findWorkspaceRoot } from '../../context/scope.ts';
import { projectKnowledge, workspaceScopeAddress } from '../../knowledge/project-knowledge.ts';

const modelName = process.env.ASSISTANT_MODEL || 'qwen3.5:9b';

// Stateless answerer: it searches the workspace's Knowledge pages and sees no conversation memory.
const knowledgeAnswerer = new Agent({
  id: 'knowledge-answerer',
  name: 'Knowledge Answerer',
  instructions:
    'Answer the question from the project Knowledge pages. Search with knowledge_search and read the relevant page before relying on it. Cite the page name or source path you used. If the pages do not contain the answer, say so plainly instead of guessing. Be concise.',
  knowledge: projectKnowledge,
  scopes: [workspaceScopeAddress(findWorkspaceRoot())],
  model: {
    providerId: 'custom',
    modelId: modelName,
    url: process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1',
    apiKey: process.env.ASSISTANT_API_KEY || 'ollama',
  },
});

const questionInput = z.object({
  question: z.string().min(1).max(2000),
});

const answerStep = createStep({
  id: 'answer-from-knowledge',
  inputSchema: questionInput,
  outputSchema: z.object({
    answer: z.string(),
  }),
  execute: async ({ inputData }) => {
    const result = await knowledgeAnswerer.generate(inputData.question);
    return { answer: result.text };
  },
});

export const knowledgeAnswer = createWorkflow({
  id: 'knowledge-answer',
  description: 'Answer a question from the workspace Knowledge pages, citing the pages used.',
  inputSchema: questionInput,
  outputSchema: z.object({
    answer: z.string(),
  }),
})
  .then(answerStep)
  .commit();
