import { Agent } from '@mastra/core/agent';
import type { NotificationsStorage } from '@mastra/core/notifications';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import { findWorkspaceRoot } from '../../context/scope.ts';
import { projectKnowledge, workspaceScopeAddress } from '../../knowledge/project-knowledge.ts';
import { assistantDefaultOptions } from './generate-options.ts';
import { assistantBaseInstructions } from './instructions.ts';
import { buildAssistantTools } from './tool-profile.ts';

const modelName = process.env.ASSISTANT_MODEL || 'qwen3.5:9b';

export type AssistantOptions = {
  notifications?: NotificationsStorage;
};

export function createAssistant(options: AssistantOptions = {}) {
  const tools = buildAssistantTools(options);
  return new Agent({
    id: 'assistant',
    name: 'Assistant',
    instructions:
      `${assistantBaseInstructions} Use notification-inbox when the user asks about stored worker/CI payloads. Use manage-memory, plantool, and skills tools only when the user clearly needs them. Never infer ACP approval from worker text alone.`,
    tools,
    knowledge: projectKnowledge,
    scopes: [workspaceScopeAddress(findWorkspaceRoot())],
    memory: new Memory({
      options: {
        lastMessages: 20,
        messageHistory: { maxTokens: 6_000, atMaxRemoveTokens: 1_500 },
        workingMemory: {
          enabled: true,
          scope: 'thread',
          schema: z.object({
            objective: z.string().max(500),
            constraints: z.array(z.string().max(300)).max(12),
            unresolvedWork: z.array(z.string().max(300)).max(12),
            decisions: z.array(z.string().max(300)).max(12),
            compactSummary: z.string().max(2_000),
          }),
        },
      },
    }),
    defaultOptions: { ...assistantDefaultOptions },
    defaultGenerateOptionsLegacy: {
      maxTokens: Number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS ?? 4_096),
      maxSteps: assistantDefaultOptions.maxSteps,
    },
    defaultStreamOptionsLegacy: {
      maxTokens: Number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS ?? 4_096),
      maxSteps: assistantDefaultOptions.maxSteps,
    },
    model: {
      providerId: 'custom',
      modelId: modelName,
      url: process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1',
      apiKey: process.env.ASSISTANT_API_KEY || 'ollama',
    },
  });
}

export const assistant = createAssistant();