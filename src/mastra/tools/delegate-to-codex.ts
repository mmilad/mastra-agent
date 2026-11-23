import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

type RpcMessage = {
  id?: number;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
};

const timeoutMs = 5 * 60 * 1000;

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
    const adapterPath = fileURLToPath(import.meta.resolve('@agentclientprotocol/codex-acp'));
    const child = spawn(process.execPath, [adapterPath], {
      cwd: projectRoot,
      env: { ...process.env, INITIAL_AGENT_MODE: 'workspace-write', NO_BROWSER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    let stderr = '';
    let processError: string | undefined;
    child.on('error', (error) => {
      processError = error.message;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    let nextId = 1;

    const stopChild = () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };

    const abort = () => stopChild();
    abortSignal?.addEventListener('abort', abort, { once: true });

    const send = (message: Record<string, unknown>) => {
      if (!child.stdin.writable) throw new Error('Codex ACP process closed its input');
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const receive = async (
      requestId: number,
      onNotification?: (message: RpcMessage) => void,
    ): Promise<RpcMessage> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (abortSignal?.aborted) throw new Error('Codex delegation was cancelled');
        if (processError) throw new Error(`Could not start Codex ACP: ${processError}`);
        const remaining = deadline - Date.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const line = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Codex ACP request timed out')), remaining);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (line.done) {
          throw new Error(`Codex ACP exited before replying. ${stderr.trim()}`.trim());
        }
        let message: RpcMessage;
        try {
          message = JSON.parse(line.value) as RpcMessage;
        } catch {
          continue;
        }

        if (message.method) {
          if (message.id !== undefined) {
            send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: `Unsupported ACP client request: ${message.method}` },
            });
          } else {
            onNotification?.(message);
          }
          continue;
        }
        if (message.id !== requestId) continue;
        if (message.error) {
          throw new Error(`Codex ACP error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`);
        }
        return message;
      }
      throw new Error('Codex ACP request timed out');
    };

    try {
      const initializeId = nextId++;
      send({
        jsonrpc: '2.0',
        id: initializeId,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: 'mastra-assistant', version: '0.1.0' },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      });
      await receive(initializeId);

      const sessionIdRequest = nextId++;
      send({
        jsonrpc: '2.0',
        id: sessionIdRequest,
        method: 'session/new',
        params: { cwd: projectRoot, mcpServers: [] },
      });
      const sessionResponse = await receive(sessionIdRequest);
      const sessionId = sessionResponse.result?.sessionId;
      if (typeof sessionId !== 'string') throw new Error('Codex ACP did not return a session ID');

      const promptId = nextId++;
      let response = '';
      send({
        jsonrpc: '2.0',
        id: promptId,
        method: 'session/prompt',
        params: {
          sessionId,
          prompt: [
            {
              type: 'text',
              text: `Complete this task in the current project workspace only: ${projectRoot}. You may create or edit files in this directory when the task asks for it. Do not access or modify files outside this workspace. Avoid destructive commands and do not change unrelated files. Report what you actually did and any verification performed.\n\nTask: ${task}`,
            },
          ],
        },
      });
      const promptResponse = await receive(promptId, (message) => {
        if (message.method !== 'session/update') return;
        const update = message.params?.update as Record<string, unknown> | undefined;
        if (update?.sessionUpdate !== 'agent_message_chunk') return;
        const content = update.content as Record<string, unknown> | undefined;
        if (typeof content?.text === 'string') response += content.text;
      });

      return {
        response: response.trim() || 'Codex finished without a text response.',
        stopReason: String(promptResponse.result?.stopReason ?? 'unknown'),
      };
    } finally {
      abortSignal?.removeEventListener('abort', abort);
      stopChild();
    }
  },
});
