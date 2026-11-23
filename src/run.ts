import { mastra } from './mastra/index.ts';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { findProjectRoot } from './mastra/tools/delegate-to-codex.ts';
import { taskRegistry } from './mastra/tools/task-registry.ts';

const agent = mastra.getAgent('assistant');
const threadId = randomUUID();
const resourceId = 'local-terminal-user';
const prompt = process.argv.slice(2).join(' ').trim();

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
  console.log(`Conversation: ${threadId}\n`);
  terminal.prompt();
  for await (const line of terminal) {
    const text = line.trim();
    if (text === ':exit' || text === ':quit') break;
    if (text) await send(text);
    terminal.prompt();
  }
  terminal.close();
  const cancelled = taskRegistry.cancelWorkspace(findProjectRoot(process.cwd()));
  if (cancelled) console.log(`Cancelled ${cancelled} active task${cancelled === 1 ? '' : 's'} before closing.`);
}
