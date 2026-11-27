import { buildDelegateHandoffBrief, formatDelegateHandoffForAssistant } from './delegate-handoff.ts';

/** @deprecated Prefer delegate-handoff workflow + formatDelegateHandoffForAssistant. */
export function buildDelegateSupervisorPrompt(userText: string): string {
  return formatDelegateHandoffForAssistant(buildDelegateHandoffBrief(userText));
}