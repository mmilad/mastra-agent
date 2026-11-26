import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { supervisorBranches } from '../../supervisor/triage.ts';
import { triageUserPromptWithLlm } from '../../supervisor/llm-triage.ts';
import { executeSupervisorTurn } from '../../supervisor/execute.ts';
import { ingestUserPrompt } from '../../supervisor/prompt-ingest.ts';
import { promptKinds } from '../../supervisor/prompt-kinds.ts';

const turnInput = z.object({
  text: z.string().min(1).max(16_000),
  resourceId: z.string().min(8).max(128),
  threadId: z.string().uuid(),
  syncReply: z.boolean().optional(),
});

const subIntentSchema = z.object({
  text: z.string(),
  kinds: z.array(z.enum(promptKinds)),
  suggestedBranch: z.enum(supervisorBranches).optional(),
});

const ingestStep = createStep({
  id: 'prompt-ingest',
  inputSchema: turnInput,
  outputSchema: turnInput.extend({
    kinds: z.array(z.enum(promptKinds)),
    primaryKind: z.enum(promptKinds),
    compound: z.boolean(),
    subIntents: z.array(subIntentSchema),
    ingestSource: z.enum(['heuristic', 'llm']),
  }),
  execute: async ({ inputData }) => {
    const ingested = await ingestUserPrompt(inputData.text);
    return {
      ...inputData,
      kinds: ingested.kinds,
      primaryKind: ingested.primaryKind,
      compound: ingested.compound,
      subIntents: ingested.subIntents,
      ingestSource: ingested.ingestSource,
    };
  },
});

const triageStep = createStep({
  id: 'supervisor-triage',
  inputSchema: ingestStep.outputSchema,
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
  description: 'Ingest prompt kinds, triage into answer, research, or delegate branches, then execute.',
  inputSchema: turnInput,
  outputSchema: executeStep.outputSchema,
})
  .then(ingestStep)
  .then(triageStep)
  .then(executeStep)
  .commit();

export type SupervisorRoutingMeta = {
  primaryKind?: string;
  compound?: boolean;
  kinds?: string[];
  ingestSource?: string;
  triageSource?: string;
};

export type SupervisorRoutingOutcome = {
  branch: (typeof supervisorBranches)[number];
  delivered: boolean;
  responseText?: string;
  routing?: SupervisorRoutingMeta;
};

function routingMetaFromWorkflowResult(result: {
  steps?: Record<string, unknown>;
}): SupervisorRoutingMeta | undefined {
  const steps = result.steps;
  if (!steps || typeof steps !== 'object') return undefined;
  const ingestRaw = steps['prompt-ingest'];
  const triageRaw = steps['supervisor-triage'];
  const ingestOut =
    ingestRaw && typeof ingestRaw === 'object' && ingestRaw !== null && 'output' in ingestRaw
      ? (ingestRaw as { output?: Record<string, unknown> }).output
      : undefined;
  const triageOut =
    triageRaw && typeof triageRaw === 'object' && triageRaw !== null && 'output' in triageRaw
      ? (triageRaw as { output?: Record<string, unknown> }).output
      : undefined;
  if (!ingestOut && !triageOut) return undefined;
  return {
    ...(typeof ingestOut?.primaryKind === 'string' ? { primaryKind: ingestOut.primaryKind } : {}),
    ...(typeof ingestOut?.compound === 'boolean' ? { compound: ingestOut.compound } : {}),
    ...(Array.isArray(ingestOut?.kinds) ? { kinds: ingestOut.kinds.map(String) } : {}),
    ...(typeof ingestOut?.ingestSource === 'string' ? { ingestSource: ingestOut.ingestSource } : {}),
    ...(typeof triageOut?.triageSource === 'string' ? { triageSource: triageOut.triageSource } : {}),
  };
}

export async function runSupervisorRouting(
  mastra: import('@mastra/core').Mastra,
  input: z.infer<typeof turnInput>,
): Promise<SupervisorRoutingOutcome> {
  const workflow = mastra.getWorkflow('supervisorRouting');
  const run = await workflow.createRun();
  const result = await run.start({ inputData: input });
  if (result.status !== 'success') {
    const msg = result.status === 'failed' ? result.error?.message ?? 'supervisor workflow failed' : result.status;
    throw new Error(String(msg));
  }
  const payload = result.result as { branch: (typeof supervisorBranches)[number]; delivered: boolean; responseText?: string };
  const routing = routingMetaFromWorkflowResult(result);
  return { ...payload, ...(routing && Object.keys(routing).length > 0 ? { routing } : {}) };
}