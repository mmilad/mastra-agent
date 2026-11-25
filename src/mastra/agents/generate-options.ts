import type { Agent } from '@mastra/core/agent';

const defaultMaxSteps = Number(process.env.ASSISTANT_MAX_STEPS ?? 12);
const parsed = Number.isFinite(defaultMaxSteps) && defaultMaxSteps > 0 ? Math.floor(defaultMaxSteps) : 12;

/** Enough LLM steps for tool call(s) plus a user-facing answer (Ollama models often stop after tools). */
export const assistantDefaultMaxSteps = parsed;

export const assistantDefaultOptions = {
  maxSteps: assistantDefaultMaxSteps,
  modelSettings: {
    maxOutputTokens: Number(process.env.ASSISTANT_MAX_OUTPUT_TOKENS ?? 4_096),
  },
} as const;

const continuationPrompt =
  'Your last turn did not include a complete user-facing answer. Summarize the result for the user now in plain language. Do not call tools unless you must.';

export type AssistantGenerateOptions = {
  maxSteps?: number;
  memory?: { thread: string; resource: string };
  instructions?: string;
  [key: string]: unknown;
};

type GenerateResult = { text?: string | null };

export async function generateWithCompletion(
  agent: Agent,
  prompt: string,
  options: AssistantGenerateOptions = {},
): Promise<GenerateResult> {
  const merged: AssistantGenerateOptions = {
    ...options,
    maxSteps: options.maxSteps ?? assistantDefaultMaxSteps,
  };
  const first = (await agent.generate(prompt, merged as never)) as GenerateResult;
  if (first.text?.trim()) return first;
  const second = (await agent.generate(continuationPrompt, merged as never)) as GenerateResult;
  return second.text?.trim() ? second : first;
}