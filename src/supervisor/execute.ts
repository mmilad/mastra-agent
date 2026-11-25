import type { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import { generateWithCompletion } from '../mastra/agents/generate-options.ts';
import { instructionsForBranch } from '../mastra/agents/instructions.ts';
import { buildDelegateSupervisorPrompt } from './delegate-prompt.ts';
import type { SupervisorBranch } from './triage.ts';

export type SupervisorTurnInput = {
  text: string;
  resourceId: string;
  threadId: string;
  branch: SupervisorBranch;
  /** When true (CLI), block until model text is available via generate(). */
  syncReply?: boolean;
};

export type SupervisorTurnResult = {
  branch: SupervisorBranch;
  delivered: boolean;
  responseText?: string;
};

async function runResearch(mastra: Mastra, question: string): Promise<string> {
  const workflow = mastra.getWorkflow('knowledgeAnswer');
  const run = await workflow.createRun();
  const result = await run.start({ inputData: { question } });
  if (result.status !== 'success') {
    const msg = result.status === 'failed' ? result.error?.message ?? 'research workflow failed' : result.status;
    throw new Error(String(msg));
  }
  const answer = (result.result as { answer?: string } | undefined)?.answer?.trim();
  if (!answer) throw new Error('Research workflow returned no answer.');
  return answer;
}

async function deliverSync(
  agent: Agent,
  text: string,
  thread: { resourceId: string; threadId: string },
  branch: SupervisorBranch,
): Promise<string> {
  const response = await generateWithCompletion(agent, text, {
    memory: { thread: thread.threadId, resource: thread.resourceId },
    instructions: instructionsForBranch(branch),
  });
  return response.text?.trim() ?? '';
}

async function deliverAsync(agent: Agent, text: string, thread: { resourceId: string; threadId: string }): Promise<void> {
  const result = agent.sendMessage(text, { resourceId: thread.resourceId, threadId: thread.threadId });
  await result.accepted;
}

export async function executeSupervisorTurn(mastra: Mastra, input: SupervisorTurnInput): Promise<SupervisorTurnResult> {
  const agent = mastra.getAgent('assistant');
  if (!agent) throw new Error('Assistant agent is not configured.');
  const thread = { resourceId: input.resourceId, threadId: input.threadId };

  if (input.branch === 'research') {
    const answer = await runResearch(mastra, input.text);
    const combined = `Use this project knowledge lookup when answering the user.\n\nKnowledge answer:\n${answer}\n\nUser message:\n${input.text}`;
    if (input.syncReply) {
      const responseText = await deliverSync(agent, combined, thread, input.branch);
      return { branch: input.branch, delivered: true, responseText };
    }
    await deliverAsync(agent, combined, thread);
    return { branch: input.branch, delivered: true };
  }

  const prompt =
    input.branch === 'delegate' ? buildDelegateSupervisorPrompt(input.text) : input.text;

  if (input.syncReply) {
    const responseText = await deliverSync(agent, prompt, thread, input.branch);
    return { branch: input.branch, delivered: true, responseText };
  }
  await deliverAsync(agent, prompt, thread);
  return { branch: input.branch, delivered: true };
}