import { Agent } from '@mastra/core/agent';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { searchProjectKnowledge } from '../tools/knowledge.ts';

const modelName = process.env.ASSISTANT_MODEL || 'qwen3.5:9b';

// Stateless answerer: it sees only the retrieved passages, no conversation memory.
const knowledgeAnswerer = new Agent({
  id: 'knowledge-answerer',
  name: 'Knowledge Answerer',
  instructions:
    'Answer the question using only the numbered passages you are given. Cite the source path of each passage you use. If the passages do not contain the answer, say so plainly instead of guessing. Be concise.',
  model: {
    providerId: 'custom',
    modelId: modelName,
    url: process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1',
    apiKey: process.env.ASSISTANT_API_KEY || 'ollama',
  },
});

const questionInput = z.object({
  question: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(10).default(5),
});

const retrieveStep = createStep({
  id: 'retrieve-knowledge',
  inputSchema: questionInput,
  outputSchema: z.object({
    question: z.string(),
    passages: z.array(z.object({ source: z.string(), score: z.number(), text: z.string() })),
  }),
  execute: async ({ inputData }) => {
    const passages = await searchProjectKnowledge(inputData.question, inputData.topK);
    return { question: inputData.question, passages };
  },
});

const answerStep = createStep({
  id: 'answer-from-passages',
  inputSchema: z.object({
    question: z.string(),
    passages: z.array(z.object({ source: z.string(), score: z.number(), text: z.string() })),
  }),
  outputSchema: z.object({
    answer: z.string(),
    sources: z.array(z.string()),
  }),
  execute: async ({ inputData }) => {
    const sources = [...new Set(inputData.passages.map((passage) => passage.source))];
    if (inputData.passages.length === 0) {
      return { answer: 'Keine passenden Passagen im Wissensindex gefunden. Bitte "npm run knowledge:index" prüfen.', sources };
    }
    const context = inputData.passages
      .map((passage, index) => `[${index + 1}] (${passage.source})\n${passage.text}`)
      .join('\n\n');
    const result = await knowledgeAnswerer.generate(`Passages:\n${context}\n\nQuestion: ${inputData.question}`);
    return { answer: result.text, sources };
  },
});

export const knowledgeAnswer = createWorkflow({
  id: 'knowledge-answer',
  description: 'Retrieve passages from the project knowledge index and answer a question from them, with sources.',
  inputSchema: questionInput,
  outputSchema: z.object({
    answer: z.string(),
    sources: z.array(z.string()),
  }),
})
  .then(retrieveStep)
  .then(answerStep)
  .commit();
