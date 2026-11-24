import { mastra } from './mastra/index.ts';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { findWorkspaceRoot, projectResourceId } from './context/scope.ts';
import { saveSelectedThread, selectConversation } from './context/conversations.ts';
import { findProjectRoot } from './mastra/tools/delegate-to-codex.ts';
import { taskRegistry } from './mastra/tools/task-registry.ts';

const agent = mastra.getAgent('assistant');
const root = findWorkspaceRoot();
const resourceId = projectResourceId(root);
const args = process.argv.slice(2);
const requestedThreadIndex = args.indexOf('--thread');
const requestedThread = requestedThreadIndex >= 0 ? args[requestedThreadIndex + 1] : undefined;
if (requestedThreadIndex >= 0 && !requestedThread) throw new Error('--thread requires a conversation ID.');
const startNew = args.includes('--new');
const listOnly = args.includes('--list');
const prompt = args.filter((arg, index) => arg !== '--new' && arg !== '--list' && arg !== '--thread' && (requestedThreadIndex < 0 || index !== requestedThreadIndex + 1)).join(' ').trim();
const memory = await agent.getMemory();
if (!memory) throw new Error('Assistant conversation memory is not configured.');

if (listOnly) {
  const threads = await memory.listThreads({ filter: { resourceId }, page: 0, perPage: 50 });
  for (const thread of threads.threads) console.log(`${thread.id}\t${thread.updatedAt.toISOString()}\t${thread.title ?? '(untitled)'}`);
  if (threads.threads.length === 0) console.log('No conversations in this project yet.');
  process.exit(0);
}

let threadId = await selectConversation(memory, root, { requestedThreadId: requestedThread, startNew });

async function send(text: string): Promise<void> {
  try {
    const response = await agent.generate(text, { memory: { thread: threadId, resource: resourceId } });
    console.log(`\nAssistant: ${response.text}\n`);
  } catch (error) {
    console.error('\nAssistant request failed:', error instanceof Error ? error.message : String(error), '\n');
  }
}

if (prompt) {
  await send(prompt);
} else if (!stdin.isTTY) {
  console.error('Usage: npm run chat -- "Your message"  (or run without arguments in an interactive terminal)');
  process.exitCode = 1;
} else {
  const terminal = createInterface({ input: stdin, output: stdout, prompt: 'You: ' });
  console.log('Mastra assistant · type :exit to end this conversation.');
  console.log(`Project conversation: ${threadId} · type :new to start another, :threads to list, :use <id> to switch.\n`);
  terminal.prompt();
  for await (const line of terminal) {
    const text = line.trim();
    if (text === ':exit' || text === ':quit') break;
    if (text === ':new') {
      threadId = await selectConversation(memory, root, { startNew: true });
      console.log(`Started conversation: ${threadId}`);
      terminal.prompt();
      continue;
    }
    if (text === ':threads') {
      const threads = await memory.listThreads({ filter: { resourceId }, page: 0, perPage: 50 });
      for (const thread of threads.threads) console.log(`${thread.id}\t${thread.updatedAt.toISOString()}\t${thread.title ?? '(untitled)'}`);
      terminal.prompt();
      continue;
    }
    if (text.startsWith(':use ')) {
      const id = text.slice(5).trim();
      const existing = await memory.getThreadById({ threadId: id });
      if (existing?.resourceId !== resourceId) {
        terminal.write('No conversation with that ID exists in this project.\n');
        terminal.prompt();
        continue;
      }
      threadId = existing.id;
      saveSelectedThread(root, threadId);
      console.log(`Switched to: ${threadId}`);
      terminal.prompt();
      continue;
    }
    if (text) await send(text);
    terminal.prompt();
  }
  terminal.close();
  const cancelled = taskRegistry.cancelWorkspace(findProjectRoot(process.cwd()));
  if (cancelled) console.log(`Cancelled ${cancelled} active task${cancelled === 1 ? '' : 's'} before closing.`);
}
