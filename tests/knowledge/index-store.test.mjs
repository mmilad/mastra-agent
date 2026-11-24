import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectKnowledgeSources, knowledgeDatabaseUrl, knowledgeIndexName } from '../../src/knowledge/index-store.ts';
import { embedTexts, embeddingDimension } from '../../src/knowledge/embedder.ts';

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

test('index names are per workspace and database URL is a plain file path', () => {
  assert.notEqual(knowledgeIndexName('/a'), knowledgeIndexName('/b'));
  assert.match(knowledgeIndexName('/a'), /^k_[0-9a-f]{24}$/);
  assert.match(knowledgeDatabaseUrl('/app'), /^file:.*knowledge\.db$/);
  assert.ok(!knowledgeDatabaseUrl('/app').startsWith('file://'));
});

test('embedTexts rejects vectors with the wrong dimension', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(init.body).input;
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2] })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await assert.rejects(() => embedTexts(['hello'], 'search_query: '), /dimensions/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(typeof embeddingDimension, 'number');
});

test('embedTexts sends the task prefix and returns vectors in input order', async () => {
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).input;
    // Return items out of order; each vector is tagged with its true input position.
    const data = sent.map((_, index) => ({ index, embedding: new Array(embeddingDimension).fill(index) })).reverse();
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const vectors = await embedTexts(['a', 'b'], 'search_document: ');
    assert.deepEqual(sent, ['search_document: a', 'search_document: b']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0][0], 0);
    assert.equal(vectors[1][0], 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
