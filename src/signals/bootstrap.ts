import type { Mastra } from '@mastra/core';
import { registerSignalRuntime } from './runtime.ts';
import { wireWorkerTaskSignals } from './worker-bridge.ts';
import { signalIntakeService } from './intake-service.ts';
import { taskRegistry } from '../mastra/tools/task-registry.ts';
import { projectResourceId, findWorkspaceRoot } from '../context/scope.ts';
import { bootstrapDefaultGitHubSubscription } from './subscriptions.ts';

let reconciled = false;

export function bootstrapSignals(mastra: Mastra): void {
  registerSignalRuntime(mastra);
  wireWorkerTaskSignals(taskRegistry);
  bootstrapDefaultGitHubSubscription(
    projectResourceId(findWorkspaceRoot()),
    process.env.GITHUB_DEFAULT_CONVERSATION_ID?.trim(),
  );
  if (!reconciled) {
    reconciled = true;
    void signalIntakeService.reconcilePending().then(({ processed, failed }) => {
      if (processed || failed) {
        console.info(`[signals] Reconciled ${processed} pending intake event(s); ${failed} failed.`);
      }
    });
  }
}