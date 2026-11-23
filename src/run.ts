import { mastra } from './mastra/index.ts';

const prompt = process.argv.slice(2).join(' ').trim();
const model = process.env.MASTRA_MODEL || 'openai/gpt-4.1-mini';

if (!prompt) {
  console.error('Usage: npm run chat -- "Your message"');
  process.exitCode = 1;
} else if (model.startsWith('openai/') && !process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY in .env (copy .env.example first) or in your shell.');
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
