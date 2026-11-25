#!/usr/bin/env node
/**
 * Long-running supervisor loop (MAST-67): Mastra runtime + periodic intake reconcile.
 * Use alongside or instead of watch-mode `mastra dev` when you need durable intake recovery.
 */
import { mastra } from './mastra/index.ts';
import { signalIntakeService } from './signals/intake-service.ts';

const tickMs = Number(process.env.SUPERVISOR_RECONCILE_MS ?? 60_000);
let stopping = false;

async function tick(): Promise<void> {
  const { processed, failed } = await signalIntakeService.reconcilePending();
  if (processed || failed) {
    console.info(`[supervisor] reconciled ${processed} intake row(s); ${failed} failed`);
  }
}

function shutdown(): void {
  if (stopping) return;
  stopping = true;
  console.info('[supervisor] shutting down.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Touch mastra so agents, workflows and signal bootstrap run.
void mastra;
console.info(`[supervisor] running; intake reconcile every ${tickMs}ms. Ctrl+C to stop.`);

await tick();
const timer = setInterval(() => {
  void tick();
}, tickMs);

void timer;