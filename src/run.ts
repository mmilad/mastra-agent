import { mastra } from './mastra/index.ts';

const prompt = process.argv.slice(2).join(' ').trim();
const model = process.env.ASSISTANT_MODEL || 'llama3';

if (!prompt) {
  console.error('Usage: npm run chat -- "Your message"');
  process.exitCode = 1;
} else {
  try {
    const response = await mastra.getAgent('assistant').generate(prompt);
    console.log(response.text);
  } catch (error) {
    console.error('Assistant request failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
