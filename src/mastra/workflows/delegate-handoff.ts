import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { buildDelegateHandoffBrief } from '../../supervisor/delegate-handoff.ts';

const handoffInput = z.object({
  text: z.string().min(1).max(16_000),
});

const briefOutput = z.object({
  objective: z.string(),
  worker: z.enum(['codex', 'cursor', 'claude']),
  acceptanceCriteria: z.array(z.string()),
  constraints: z.array(z.string()),
  handoffSource: z.literal('heuristic'),
});

const assembleBrief = createStep({
  id: 'assemble-delegate-brief',
  inputSchema: handoffInput,
  outputSchema: briefOutput,
  execute: async ({ inputData }) => buildDelegateHandoffBrief(inputData.text),
});

export const delegateHandoff = createWorkflow({
  id: 'delegate-handoff',
  description: 'Normalize delegate objectives, worker hint, and acceptance criteria before delegate-task.',
  inputSchema: handoffInput,
  outputSchema: briefOutput,
})
  .then(assembleBrief)
  .commit();