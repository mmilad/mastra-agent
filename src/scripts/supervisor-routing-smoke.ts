/**
 * Print supervisor-routing step outputs without Studio.
 *
 *   npm run supervisor:smoke                              # default cases, through triage
 *   MASTRA_DEV_URL=http://localhost:4111 SUPERVISOR_SMOKE_FULL=1 npm run supervisor:smoke -- "…"  # via running mastra dev (preferred)
 *   SUPERVISOR_SMOKE_FULL=1 npm run supervisor:smoke -- "your prompt"   # in-process (may fight DuckDB with dev)
 */
import { ingestUserPrompt } from '../supervisor/prompt-ingest.ts';
import { triageUserPromptWithLlm } from '../supervisor/llm-triage.ts';
import { projectResourceId, findWorkspaceRoot } from '../context/scope.ts';

const defaultCases = [
  'Thanks, that helps!',
  'How does signal intake work in the docs?',
  'Explain how signal intake is documented and create hello.txt in the project root',
];

function parseArgs(argv: string[]): { through: 'triage' | 'full'; texts: string[] } {
  const through: 'triage' | 'full' =
    process.env.SUPERVISOR_SMOKE_FULL === '1' || process.env.SUPERVISOR_SMOKE_FULL === 'true' ? 'full' : 'triage';
  const texts = argv.filter((arg) => arg && arg !== '--full' && arg !== '--through-triage');
  return { through, texts: texts.length > 0 ? texts : defaultCases };
}

const { through, texts } = parseArgs(process.argv.slice(2));
const syncReply = process.env.SUPERVISOR_SMOKE_SYNC === '1';
const resourceId = projectResourceId(findWorkspaceRoot());
const threadId = process.env.SUPERVISOR_SMOKE_THREAD_ID ?? '00000000-0000-4000-8000-00000000abe1';

function stepOutput(steps: Record<string, unknown> | undefined, id: string): unknown {
  const raw = steps?.[id];
  if (raw && typeof raw === 'object' && raw !== null && 'output' in raw) {
    return (raw as { output: unknown }).output;
  }
  return raw;
}

for (const text of texts) {
  const started = Date.now();
  console.log('\n---');
  console.log('prompt:', text);
  console.log('mode:', through, through === 'full' ? `syncReply=${syncReply}` : '');

  const ingested = await ingestUserPrompt(text);
  console.log('prompt-ingest:', JSON.stringify(ingested, null, 2));

  const triaged = await triageUserPromptWithLlm(text);
  console.log(
    'supervisor-triage:',
    JSON.stringify(
      { branch: triaged.branch, triageSource: triaged.source, rationale: triaged.rationale },
      null,
      2,
    ),
  );

  if (through === 'triage') {
    console.log(`(${Date.now() - started}ms, execute skipped — use --full for full workflow)`);
    continue;
  }

  const devBase = process.env.MASTRA_DEV_URL?.replace(/\/+$/, '') ?? 'http://127.0.0.1:4111';
  let result: {
    status: string;
    error?: { message?: string };
    steps?: Record<string, unknown>;
    result?: { branch?: string; delivered?: boolean; responseText?: string };
  };
  try {
    const response = await fetch(`${devBase}/api/workflows/supervisorRouting/start-async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputData: { text, resourceId, threadId, syncReply } }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from mastra dev`);
    result = (await response.json()) as typeof result;
  } catch (httpError) {
    const msg = httpError instanceof Error ? httpError.message : String(httpError);
    if (process.env.SUPERVISOR_SMOKE_NO_FALLBACK === '1') {
      console.error('mastra dev API failed:', msg);
      continue;
    }
    console.warn('mastra dev API failed, falling back to in-process run (may conflict with mastra dev):', msg);
    const { mastra } = await import('../mastra/index.ts');
    const wf = mastra.getWorkflow('supervisorRouting');
    const run = await wf.createRun();
    result = await run.start({
      inputData: { text, resourceId, threadId, syncReply },
    });
  }
  const ms = Date.now() - started;
  console.log('workflow status:', result.status, `(${ms}ms)`);
  if (result.status !== 'success') {
    console.log('error:', result.status === 'failed' ? result.error?.message : result.status);
    continue;
  }
  const steps = result.steps as Record<string, unknown> | undefined;
  const fin = result.result as { branch?: string; delivered?: boolean; responseText?: string } | undefined;
  console.log(
    'workflow steps (ingest/triage from run):',
    JSON.stringify(
      {
        ingest: stepOutput(steps, 'prompt-ingest'),
        triage: {
          branch: (stepOutput(steps, 'supervisor-triage') as { branch?: string })?.branch,
          triageSource: (stepOutput(steps, 'supervisor-triage') as { triageSource?: string })?.triageSource,
        },
        execute: {
          branch: fin?.branch,
          delivered: fin?.delivered,
          responseTextChars: fin?.responseText?.length ?? 0,
        },
      },
      null,
      2,
    ),
  );
  if (fin?.responseText?.trim()) {
    console.log('response preview:', fin.responseText.trim().slice(0, 400));
  }
}