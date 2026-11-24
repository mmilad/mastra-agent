import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectKnowledgeSources, pageKeyFor, pageNameFor } from '../../src/knowledge/sync.ts';
import { createOllamaEmbedder, embeddingDimension } from '../../src/knowledge/embedder.ts';
import { workspaceScopeAddress } from '../../src/knowledge/project-knowledge.ts';

test('collects README.md and nested docs Markdown only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-sources-'));
  try {
    await writeFile(join(root, 'README.md'), '# Readme');
    await mkdir(join(root, 'docs', 'nested'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide');
    await writeFile(join(root, 'docs', 'nested', 'deep.md'), '# Deep');
    await writeFile(join(root, 'docs', 'image.png'), 'binary');
    const sources = (await collectKnowledgeSources(root)).map((entry) => entry.source).sort();
    assert.deepEqual(sources, ['README.md', 'docs/guide.md', 'docs/nested/deep.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing docs folder is not an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-nodocs-'));
  try {
    const sources = (await collectKnowledgeSources(root)).map((entry) => entry.source);
    assert.deepEqual(sources, ['README.md']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('page keys are flat, lowercase and stable', () => {
  assert.equal(pageKeyFor('README.md'), 'readme');
  assert.equal(pageKeyFor('docs/nested/Deep Guide.md'), 'docs-nested-deep-guide');
});

test('page name prefers the first heading', () => {
  assert.equal(pageNameFor('docs/a.md', '# Title here\n\ntext'), 'Title here');
  assert.equal(pageNameFor('docs/a.md', 'no heading'), 'a.md');
});

test('workspace scope addresses differ per workspace', () => {
  assert.notEqual(workspaceScopeAddress('/a'), workspaceScopeAddress('/b'));
  assert.match(workspaceScopeAddress('/a'), /^workspace:[0-9a-f]{24}$/);
});

test('embedder rejects vectors with the wrong dimension', async () => {
  const embedder = createOllamaEmbedder(async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  await assert.rejects(() => embedder.doEmbed({ values: ['hello'] }), /dimensions/);
});

test('embedder sends all values and returns vectors in input order', async () => {
  let sent;
  const embedder = createOllamaEmbedder(async (_url, init) => {
    sent = JSON.parse(init.body).input;
    // Respond out of order; each vector is tagged with its true input position.
    const data = sent
      .map((_, index) => ({ index, embedding: new Array(embeddingDimension).fill(index) }))
      .reverse();
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await embedder.doEmbed({ values: ['a', 'b'] });
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(result.embeddings.length, 2);
  assert.equal(result.embeddings[0][0], 0);
  assert.equal(result.embeddings[1][0], 1);
});
