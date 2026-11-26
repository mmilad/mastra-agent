#!/usr/bin/env node
import { registerSignalRuntime } from './runtime.ts';
import { signalIntakeService } from './intake-service.ts';
import { mastra } from '../mastra/index.ts';
import { formatThreadInspect, inspectStudioThread } from './thread-inspect.ts';

registerSignalRuntime(mastra);

const [command, ...rest] = process.argv.slice(2);

function formatRoutingNote(note?: string): string {
  if (!note?.trim()) return '';
  try {
    const parsed = JSON.parse(note) as { branch?: string; primaryKind?: string; compound?: boolean };
    const parts = [
      parsed.branch ? `branch=${parsed.branch}` : '',
      parsed.primaryKind ? `kind=${parsed.primaryKind}` : '',
      parsed.compound === true ? 'compound' : '',
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : note.slice(0, 120);
  } catch {
    return note.slice(0, 120);
  }
}

function printRows(rows: Array<{ eventId: string; status: string; deliveryError?: string; routingNote?: string }>) {
  if (rows.length === 0) {
    console.log('(none)');
    return;
  }
  for (const row of rows) {
    if (row.deliveryError) {
      console.log(`${row.eventId}\t${row.status}\t${row.deliveryError}`);
      continue;
    }
    const routing = formatRoutingNote(row.routingNote);
    console.log(`${row.eventId}\t${row.status}${routing ? `\t${routing}` : ''}`);
  }
}

async function main(): Promise<void> {
  if (command === 'list') {
    const which = rest[0] ?? 'pending';
    const map: Record<string, 'accepted' | 'failed' | 'unrouted' | 'dispatched'> = {
      pending: 'accepted',
      failed: 'failed',
      unrouted: 'unrouted',
      dispatched: 'dispatched',
    };
    const key = map[which];
    if (!key) {
      console.error('Usage: intake list [pending|dispatched|failed|unrouted]');
      process.exitCode = 1;
      return;
    }
    printRows(signalIntakeService.listIntakeRows(key));
    return;
  }
  if (command === 'retry') {
    const eventId = rest[0];
    if (!eventId) {
      console.error('Usage: intake retry <eventId>');
      process.exitCode = 1;
      return;
    }
    const result = await signalIntakeService.dispatchEvent(eventId);
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    console.log(`Retried ${eventId}: dispatched.`);
    return;
  }
  if (command === 'resolve') {
    const eventId = rest[0];
    const conversationId = rest[1];
    if (!eventId || !conversationId) {
      console.error('Usage: intake resolve <eventId> <conversationId>');
      process.exitCode = 1;
      return;
    }
    const result = await signalIntakeService.resolveUnrouted(eventId, conversationId);
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
      return;
    }
    console.log(`Resolved ${eventId} → ${conversationId} (dispatched=${result.dispatched}).`);
    return;
  }
  if (command === 'reconcile') {
    const { processed, failed } = await signalIntakeService.reconcilePending();
    console.log(`Reconciled ${processed} row(s); ${failed} failed.`);
    return;
  }
  if (command === 'thread') {
    const idOrUrl = rest[0];
    if (!idOrUrl) {
      console.error('Usage: intake thread <threadId|studio-url> [messageLimit]');
      process.exitCode = 1;
      return;
    }
    const limit = Number(rest[1]) > 0 ? Number(rest[1]) : 30;
    console.log(formatThreadInspect(inspectStudioThread(idOrUrl, limit)));
    return;
  }
  console.log(`Signal intake operator commands (MAST-73 / MAST-63)

  npm run intake -- list [pending|dispatched|failed|unrouted]
  npm run intake -- retry <eventId>
  npm run intake -- resolve <eventId> <conversationId>
  npm run intake -- reconcile
  npm run intake -- thread <threadId|studio-url> [limit]
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});