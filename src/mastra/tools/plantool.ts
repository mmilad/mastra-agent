import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findProjectRoot } from './delegate-to-codex.ts';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

let windowsPlantoolLaunch: { file: string; prefix: string[] } | undefined;

/**
 * On Windows, plantool is installed as a .cmd shim. Node refuses to spawn .cmd
 * files without a shell, and a shell would let ticket text reach cmd.exe. Run the
 * shim's Node entry script directly with process.execPath instead.
 */
function plantoolLaunch(): { file: string; prefix: string[] } {
  if (process.platform !== 'win32') return { file: 'plantool', prefix: [] };
  if (!windowsPlantoolLaunch) {
    const shim = execFileSync('where.exe', ['plantool.cmd'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);
    if (!shim) throw new Error('plantool.cmd was not found on PATH.');
    const entry = join(dirname(shim), 'node_modules', '@mmilad', 'plantool', 'bin', 'plantool.js');
    windowsPlantoolLaunch = { file: process.execPath, prefix: [entry] };
  }
  return windowsPlantoolLaunch;
}

export function runPlantoolJson(projectRoot: string, args: string[]): JsonValue {
  const launch = plantoolLaunch();
  const stdout = execFileSync(launch.file, [...launch.prefix, ...args, '--format', 'json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1_000_000,
    env: { ...process.env, PLANTOOL_AGENT: 'assistant' },
  });
  const result: unknown = JSON.parse(stdout);
  if (result === null || typeof result !== 'object') throw new Error('Plantool returned an unexpected JSON value.');
  return result as JsonValue;
}

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index] as { role?: unknown; content?: unknown; message?: { role?: unknown; content?: unknown } };
    const message = item?.message ?? item;
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function explicitAction(message: string, verb: RegExp, reference: string): boolean {
  if (!verb.test(message)) return false;
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactReference = new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, 'i');
  if (!exactReference.test(message)) return false;
  const actionIndex = message.search(verb);
  const leadIn = message.slice(Math.max(0, actionIndex - 32), actionIndex);
  return !/\b(?:do not|don['’]?t|never|cannot|can['’]?t|won['’]?t|should not|shouldn['’]?t)\b/i.test(leadIn);
}

function cliError(error: unknown): string {
  if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
    try {
      const parsed = JSON.parse(error.stdout) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      // Fall through to the bounded process error below.
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export const plantoolLookup = createTool({
  id: 'plantool-lookup',
  description:
    'Read the current project plan through Plantool. Use for roadmap, ticket, decision, goal, plan, and context lookups. This tool cannot write or change the plan.',
  inputSchema: z.object({
    operation: z.enum(['next', 'tree', 'ticket', 'context', 'search', 'goals', 'plans', 'decisions']),
    id: z.string().max(100).optional(),
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    projectRoot: z.string(),
    operation: z.string(),
    resultJson: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ operation, id, query, limit }) => {
    const projectRoot = findProjectRoot(process.cwd());
    let args: string[];
    switch (operation) {
      case 'next':
        args = ['next', '--limit', String(limit)];
        break;
      case 'tree':
        args = id ? ['tree', id, '--limit', String(limit), '--fields', 'row'] : ['tree', '--limit', String(limit), '--fields', 'row'];
        break;
      case 'ticket':
        if (!id) return { ok: false, projectRoot, operation, error: 'A ticket ID or key is required.' };
        args = ['ticket', 'show', id];
        break;
      case 'context':
        if (!id) return { ok: false, projectRoot, operation, error: 'A ticket ID or key is required.' };
        args = ['context', id, '--budget', '10000'];
        break;
      case 'search':
        if (!query?.trim()) return { ok: false, projectRoot, operation, error: 'A search query is required.' };
        args = ['search', query.trim(), '--type', 'ticket,goal,plan,decision', '--limit', String(limit)];
        break;
      case 'goals':
        args = ['goal', 'list'];
        break;
      case 'plans':
        args = ['plan', 'list'];
        break;
      case 'decisions':
        args = ['decision', 'list'];
        break;
    }
    try {
      const result = runPlantoolJson(projectRoot, args);
      return { ok: true, projectRoot, operation, resultJson: JSON.stringify(result).slice(0, 30_000) };
    } catch (error) {
      return { ok: false, projectRoot, operation, error: cliError(error).slice(0, 1000) };
    }
  },
});

export const createPlanTask = createTool({
  id: 'create-plan-task',
  description:
    'Create one actionable task in the current Plantool project when the user explicitly asks to add work to the plan. Search first and reuse an exact-title match; only feature or task parents are allowed.',
  inputSchema: z.object({
    title: z.string().min(3).max(160),
    description: z.string().min(10).max(3000),
    parentId: z.string().min(1).max(100),
    why: z.string().min(5).max(500),
    acceptanceCriteria: z.array(z.string().min(3).max(500)).min(1).max(8),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    created: z.boolean(),
    projectRoot: z.string(),
    ticketJson: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ title, description, parentId, why, acceptanceCriteria }, context) => {
    const projectRoot = findProjectRoot(process.cwd());
    const userText = lastUserText(context?.agent?.messages);
    if (!explicitAction(userText, /\b(create|add|plan)\b/i, parentId)) {
      return { ok: false, created: false, projectRoot, message: `I need an explicit user request to create a task under ${parentId}.` };
    }
    try {
      const matches = runPlantoolJson(projectRoot, ['search', title, '--type', 'ticket', '--limit', '20']);
      const items = matches && typeof matches === 'object' && 'items' in matches && Array.isArray(matches.items)
        ? matches.items as Array<Record<string, unknown>>
        : [];
      const existing = items.find((item) => typeof item.title === 'string' && item.title.trim().toLowerCase() === title.trim().toLowerCase());
      if (existing) {
        return {
          ok: true,
          created: false,
          projectRoot,
          ticketJson: JSON.stringify(existing),
          message: `An exact-title ticket already exists (${String(existing.key ?? existing.id)}); no duplicate was created.`,
        };
      }

      const parent = runPlantoolJson(projectRoot, ['ticket', 'show', parentId]);
      if (!parent || typeof parent !== 'object' || !('kind' in parent) || !['feature', 'task'].includes(String(parent.kind))) {
        return { ok: false, created: false, projectRoot, message: 'New tasks may only be added under a feature or existing task; decisions and options are never edited by this tool.' };
      }
      const args = [
        'ticket', 'create', '--title', title.trim(), '--description', description.trim(), '--parent', parentId,
        '--kind', 'task', '--priority', 'normal', '--why', why.trim(), '--accept', acceptanceCriteria.join(';'),
      ];
      const created = runPlantoolJson(projectRoot, args);
      return { ok: true, created: true, projectRoot, ticketJson: JSON.stringify(created).slice(0, 10_000), message: 'Created the task in the current Plantool project.' };
    } catch (error) {
      return { ok: false, created: false, projectRoot, message: cliError(error).slice(0, 1000) };
    }
  },
});

export const updatePlanTicket = createTool({
  id: 'update-plan-ticket',
  description:
    'Update the title or description of an existing non-decision Plantool ticket only when the latest user message explicitly asks to update that ticket. Human-owned decisions and their options cannot be changed.',
  inputSchema: z.object({
    ticketId: z.string().min(1).max(100),
    title: z.string().min(3).max(160).optional(),
    description: z.string().min(10).max(3000).optional(),
  }).refine((value) => Boolean(value.title || value.description), 'Provide a title or description update.'),
  outputSchema: z.object({
    ok: z.boolean(),
    projectRoot: z.string(),
    ticketJson: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ ticketId, title, description }, context) => {
    const projectRoot = findProjectRoot(process.cwd());
    const userText = lastUserText(context?.agent?.messages);
    if (!explicitAction(userText, /\b(update|change|rename|rewrite)\b/i, ticketId)) {
      return { ok: false, projectRoot, message: `I need the latest user message to explicitly request an update to ${ticketId}.` };
    }
    try {
      const existing = runPlantoolJson(projectRoot, ['ticket', 'show', ticketId]);
      if (!existing || typeof existing !== 'object' || !('kind' in existing)) {
        return { ok: false, projectRoot, message: `Plantool did not return the ${ticketId} ticket.` };
      }
      if (['decision', 'option'].includes(String(existing.kind))) {
        return { ok: false, projectRoot, message: 'Person-owned decisions and their options remain pending until the person chooses.' };
      }
      if (!['task', 'feature', 'bug'].includes(String(existing.kind))) {
        return { ok: false, projectRoot, message: `Tickets of kind ${String(existing.kind)} are not editable through this tool.` };
      }
      const args = ['ticket', 'update', ticketId];
      if (title) args.push('--title', title.trim());
      if (description) args.push('--description', description.trim());
      runPlantoolJson(projectRoot, args);
      const updated = runPlantoolJson(projectRoot, ['ticket', 'show', ticketId]);
      return { ok: true, projectRoot, ticketJson: JSON.stringify(updated).slice(0, 10_000), message: `Updated ${ticketId} through Plantool CLI.` };
    } catch (error) {
      return { ok: false, projectRoot, message: cliError(error).slice(0, 1000) };
    }
  },
});

const M6_FEATURE_ID = '01a2139f-7726-7cba-b89d-8467d3b585cc';

export const proposeSkillOrWorkflow = createTool({
  id: 'propose-skill-or-workflow',
  description:
    'When the user explicitly asks to capture a repeating pattern, propose a new skill or Mastra workflow as a Plantool task under M6. Does not create or load skill files; human review is required before adoption.',
  inputSchema: z.object({
    kind: z.enum(['skill', 'workflow']),
    title: z.string().min(5).max(160),
    rationale: z.string().min(20).max(2000),
    suggestedAcceptance: z.array(z.string().min(5).max(300)).min(1).max(6),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    created: z.boolean(),
    projectRoot: z.string(),
    ticketJson: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ kind, title, rationale, suggestedAcceptance }, context) => {
    const projectRoot = findProjectRoot(process.cwd());
    const userText = lastUserText(context?.agent?.messages);
    if (!explicitAction(userText, /\b(propose|capture|repeat|pattern|skill|workflow)\b/i, title)) {
      return {
        ok: false,
        created: false,
        projectRoot,
        message: 'I need an explicit user request to propose a new skill or workflow in Plantool.',
      };
    }
    const description = `Proposed ${kind}: ${rationale}\n\nThis is a draft ticket only; do not load skill bodies until the user approves.`;
    const why = `Repeated ${kind} pattern observed in conversation; needs human review before implementation.`;
    const args = [
      'ticket', 'create', '--title', title.trim(), '--description', description, '--parent', M6_FEATURE_ID,
      '--kind', 'task', '--priority', 'low', '--labels', `m6-${kind},not-mvp`, '--why', why,
      '--accept', suggestedAcceptance.join(';'),
    ];
    try {
      const created = runPlantoolJson(projectRoot, args);
      return {
        ok: true,
        created: true,
        projectRoot,
        ticketJson: JSON.stringify(created).slice(0, 10_000),
        message: `Proposed ${kind} "${title}" as a Plantool task for human review.`,
      };
    } catch (error) {
      return { ok: false, created: false, projectRoot, message: cliError(error).slice(0, 1000) };
    }
  },
});

export const commentOnPlanTicket = createTool({
  id: 'comment-on-plan-ticket',
  description:
    'Add a short evidence or planning note to an existing Plantool ticket only when the latest user message explicitly asks for a comment or note on that ticket.',
  inputSchema: z.object({
    ticketId: z.string().min(1).max(100),
    comment: z.string().min(5).max(2000),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    projectRoot: z.string(),
    message: z.string(),
    commentJson: z.string().optional(),
  }),
  execute: async ({ ticketId, comment }, context) => {
    const projectRoot = findProjectRoot(process.cwd());
    const userText = lastUserText(context?.agent?.messages);
    if (!explicitAction(userText, /\b(comment|note|record)\b/i, ticketId)) {
      return { ok: false, projectRoot, message: `I need an explicit user request to add a note to ${ticketId}.` };
    }
    try {
      runPlantoolJson(projectRoot, ['ticket', 'show', ticketId]);
      const result = runPlantoolJson(projectRoot, ['comment', 'add', ticketId, comment.trim(), '--author', 'assistant']);
      return { ok: true, projectRoot, message: `Added a note to ${ticketId} through Plantool CLI.`, commentJson: JSON.stringify(result).slice(0, 10_000) };
    } catch (error) {
      return { ok: false, projectRoot, message: cliError(error).slice(0, 1000) };
    }
  },
});
