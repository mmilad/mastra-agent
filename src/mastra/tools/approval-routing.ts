import { findProjectRoot } from './delegate-to-codex.ts';
import { taskRegistry } from './task-registry.ts';
import { isInformalApproval, isInformalDenial } from '../../policy/approval-utterance.ts';

/** Studio / chat fast path: “approve it” resolves the pending task for this thread. */
export function tryApplyApprovalUserMessage(
  message: string,
  conversationId?: string,
): { handled: true; message: string } | { handled: false } {
  const trimmed = message.trim();
  if (!trimmed) return { handled: false };
  const approved = isInformalApproval(trimmed);
  const denied = isInformalDenial(trimmed);
  if (!approved && !denied) return { handled: false };

  const projectRoot = findProjectRoot(process.cwd());
  const pending = taskRegistry.findPendingApproval(projectRoot, conversationId);
  if (!pending?.approval) {
    return {
      handled: true,
      message: denied
        ? 'There is no worker permission waiting on this conversation to deny.'
        : 'There is no worker permission waiting on this conversation. Ask for task status or wait for the approval prompt.',
    };
  }

  const result = taskRegistry.resolveApproval(
    pending.taskId,
    projectRoot,
    pending.approval.approvalToken,
    { approved: approved },
    trimmed,
  );
  return { handled: true, message: result.message };
}