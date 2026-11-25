import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { supervisorBranches } from '../../supervisor/triage.ts';
import { triageUserPromptWithLlm } from '../../supervisor/llm-triage.ts';
import { executeSupervisorTurn } from '../../supervisor/execute.ts';

const turnInput = z.object({
  text: z.string().min(1).max(16_000),
  resourceId: z.string().min(8).max(128),
  threadId: z.string().uuid(),
  syncReply: z.boolean().optional(),
});

const triageStep = createStep({
  id: 'supervisor-triage',
  inputSchema: turnInput,
  outputSchema: turnInput.extend({
    branch: z.enum(supervisorBranches),
    triageSource: z.enum(['llm', 'heuristic']).optional(),
  }),
  execute: async ({ inputData }) => {
    const triaged = await triageUserPromptWithLlm(inputData.text);
    return {
      ...inputData,
      branch: triaged.branch,
      ...(triaged.source ? { triageSource: triaged.source } : {}),
    };
  },
});

const triagedInput = turnInput.extend({ branch: z.enum(supervisorBranches) });

const executeStep = createStep({
  id: 'supervisor-execute',
  inputSchema: triagedInput,
  outputSchema: z.object({
    branch: z.enum(supervisorBranches),
    delivered: z.boolean(),
    responseText: z.string().optional(),
  }),
  execute: async ({ inputData, mastra }) => {
    if (!mastra) throw new Error('Mastra instance is required for supervisor execution.');
    const result = await executeSupervisorTurn(mastra, {
      text: inputData.text,
      resourceId: inputData.resourceId,
      threadId: inputData.threadId,
      branch: inputData.branch,
      syncReply: inputData.syncReply,
    });
    return result;
  },
});

export const supervisorRouting = createWorkflow({
  id: 'supervisor-routing',
  description: 'Triage user input into answer, research, or delegate branches and execute.',
  inputSchema: turnInput,
  outputSchema: executeStep.outputSchema,
})
  .then(triageStep)
  .then(executeStep)
  .commit();

export async function runSupervisorRouting(
  mastra: import('@mastra/core').Mastra,
  input: z.infer<typeof turnInput>,
): Promise<{ branch: (typeof supervisorBranches)[number]; delivered: boolean; responseText?: string }> {
  const workflow = mastra.getWorkflow('supervisorRouting');
  const run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  if (result.status !== 'success') {
    const msg = result.status === 'failed' ? result.error?.message ?? 'supervisor workflow failed' : result.status;
    throw new Error(String(msg));
  }
  return result.result as { branch: (typeof supervisorBranches)[number]; delivered: boolean; responseText?: string };
}