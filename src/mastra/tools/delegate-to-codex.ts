import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { AcpWorkerClient } from '../../integrations/acp/client.ts';
import { codexAcpLaunch } from '../../integrations/acp/providers.ts';

function findProjectRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'package.json')) &&
      existsSync(join(current, 'src', 'mastra'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find the Mastra project root above ${start}`);
    }
    current = parent;
  }
}

/** Run one Codex task using ACP, scoped to this project workspace. */
export const delegateToCodex = createTool({
  id: 'delegate-to-codex',
  description:
    'Delegate a bounded task in the current project to the locally authenticated Codex agent. Codex may read and edit files inside this project workspace. Use for project changes and inspections; wait for the actual result before reporting completion.',
  inputSchema: z.object({
    task: z.string().min(1).max(4000).describe('A specific task for Codex to perform'),
  }),
  outputSchema: z.object({
    response: z.string(),
    stopReason: z.string(),
  }),
  execute: async ({ task }, { abortSignal }) => {
    const projectRoot = findProjectRoot(process.cwd());
    const client = await AcpWorkerClient.start(codexAcpLaunch(projectRoot));
    let response = '';
    client.events.on('update', (message) => {
      if (message.method !== 'session/update') return;
      const update = message.params.update as Record<string, unknown> | undefined;
      if (update?.sessionUpdate !== 'agent_message_chunk') return;
      const content = update.content as Record<string, unknown> | undefined;
      if (typeof content?.text === 'string') response += content.text;
    });
    try {
      const sessionId = await client.newSession(projectRoot);
      const promptResponse = await client.prompt(
        sessionId,
        `Complete this task in the current project workspace only: ${projectRoot}. You may create or edit files in this directory when the task asks for it. Do not access or modify files outside this workspace. Avoid destructive commands and do not change unrelated files. Report what you actually did and any verification performed.\n\nTask: ${task}`,
        abortSignal,
      );

      return {
        response: response.trim() || 'Codex finished without a text response.',
        stopReason: String(promptResponse.stopReason ?? 'unknown'),
      };
    } finally {
      client.close();
    }
  },
});
