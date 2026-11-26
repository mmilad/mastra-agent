import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { ingestUserPromptHeuristic } from '../../src/supervisor/prompt-ingest.ts';
import { triageHighConfidenceBranch, triageUserPrompt } from '../../src/supervisor/triage.ts';

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), 'triage-golden.jsonl');

const cases = readFileSync(goldenPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line));

for (const row of cases) {
  const label = row.text.slice(0, 60).replace(/\s+/g, ' ');
  test(`golden triage: ${label}`, () => {
    const fast = triageHighConfidenceBranch(row.text);
    if (row.expectFastPath) {
      assert.equal(fast, row.branch, `fast path branch for: ${row.text}`);
    } else {
      assert.equal(fast, undefined, `expected ambiguous fast path for: ${row.text}`);
    }
    assert.equal(triageUserPrompt(row.text), row.branch, `full heuristic branch for: ${row.text}`);
    const ingested = ingestUserPromptHeuristic(row.text);
    if (row.kind) {
      assert.ok(ingested.kinds.includes(row.kind), `ingest kind ${row.kind}`);
    }
    if (row.expectFastPath === false && row.text.includes(' and ')) {
      assert.equal(ingested.compound, true);
    }
  });
}