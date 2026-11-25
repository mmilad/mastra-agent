import { Agent } from '@mastra/core/agent';
import { supervisorBranches, triageUserPrompt, type SupervisorBranch } from './triage.ts';

const modelName = process.env.ASSISTANT_MODEL || 'qwen3.5:9b';

const triageAgent = new Agent({
  id: 'supervisor-triage',
  name: 'Supervisor Triage',
  instructions: `You classify a single user message into exactly one routing branch for a coding assistant.

Branches:
- answer: chat, status checks, general questions, clarifications; no project file changes and no doc-deep lookup required
- research: explain how something works, find documentation, lookup in project knowledge; read-only understanding
- delegate: user wants files or code created, edited, fixed, implemented, tested, or delegated to a project worker

Reply with JSON only, no markdown fences:
{"branch":"answer"|"research"|"delegate","rationale":"one short sentence"}`,
  model: {
    providerId: 'custom',
    modelId: modelName,
    url: process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1',
    apiKey: process.env.ASSISTANT_API_KEY || 'ollama',
  },
});

export type TriageResult = {
  branch: SupervisorBranch;
  source: 'llm' | 'heuristic';
  rationale?: string;
};

function isSupervisorBranch(value: unknown): value is SupervisorBranch {
  return typeof value === 'string' && (supervisorBranches as readonly string[]).includes(value);
}

/** Parse model output into a branch (exported for tests). */
export function parseTriageBranchFromLlm(text: string | null | undefined): SupervisorBranch | undefined {
  if (!text?.trim()) return undefined;
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { branch?: unknown };
      if (isSupervisorBranch(parsed.branch)) return parsed.branch;
    } catch {
      /* try patterns below */
    }
  }
  const quoted = trimmed.match(/"branch"\s*:\s*"(answer|research|delegate)"/i);
  if (quoted) {
    const branch = quoted[1].toLowerCase() as SupervisorBranch;
    if (isSupervisorBranch(branch)) return branch;
  }
  for (const branch of supervisorBranches) {
    if (new RegExp(`\\b${branch}\\b`, 'i').test(trimmed)) return branch;
  }
  return undefined;
}

function heuristicOnly(): boolean {
  return process.env.SUPERVISOR_TRIAGE_HEURISTIC_ONLY === '1' || process.env.SUPERVISOR_TRIAGE_HEURISTIC_ONLY === 'true';
}

function triageTimeoutMs(): number {
  const parsed = Number(process.env.SUPERVISOR_TRIAGE_TIMEOUT_MS ?? 20_000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000;
}

export async function triageUserPromptWithLlm(text: string): Promise<TriageResult> {
  const trimmed = text.trim();
  if (!trimmed) return { branch: 'answer', source: 'heuristic', rationale: 'empty input' };
  if (heuristicOnly()) {
    return { branch: triageUserPrompt(trimmed), source: 'heuristic', rationale: 'heuristic-only mode' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), triageTimeoutMs());
  try {
    const prompt = `User message:\n${trimmed.slice(0, 8_000)}`;
    const result = await triageAgent.generate(prompt, { abortSignal: controller.signal, maxSteps: 1 });
    const branch = parseTriageBranchFromLlm(result.text);
    if (branch) {
      let rationale: string | undefined;
      const jsonMatch = result.text?.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as { rationale?: unknown };
          if (typeof parsed.rationale === 'string') rationale = parsed.rationale.slice(0, 300);
        } catch { /* ignore */ }
      }
      return { branch, source: 'llm', rationale };
    }
  } catch {
    /* fallback below */
  } finally {
    clearTimeout(timeout);
  }

  return {
    branch: triageUserPrompt(trimmed),
    source: 'heuristic',
    rationale: 'LLM triage unavailable or ambiguous',
  };
}