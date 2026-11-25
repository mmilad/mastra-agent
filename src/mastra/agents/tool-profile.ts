import type { NotificationsStorage } from '@mastra/core/notifications';
import { createNotificationInboxTool } from '@mastra/core/notifications';
import { cancelTask, delegateTask, getTaskStatus, resolveTaskApproval } from '../tools/managed-tasks.ts';
import { manageMemory } from '../tools/memory.ts';
import { localProjectLookup, scopedMemoryLookup } from '../tools/local-lookup.ts';
import { manageSkills } from '../tools/skills.ts';
import { commentOnPlanTicket, createPlanTask, plantoolLookup, proposeSkillOrWorkflow, updatePlanTicket } from '../tools/plantool.ts';

export type ToolProfileOptions = {
  notifications?: NotificationsStorage;
};

export function buildAssistantTools(options: ToolProfileOptions = {}) {
  const minimal = process.env.ASSISTANT_TOOL_PROFILE === 'minimal';
  const core = {
    delegateTask,
    getTaskStatus,
    cancelTask,
    resolveTaskApproval,
    localProjectLookup,
    ...(options.notifications ? { notificationInbox: createNotificationInboxTool({ storage: options.notifications }) } : {}),
  };
  if (minimal) return core;
  return {
    ...core,
    manageMemory,
    scopedMemoryLookup,
    manageSkills,
    plantoolLookup,
    createPlanTask,
    updatePlanTicket,
    commentOnPlanTicket,
    proposeSkillOrWorkflow,
  };
}