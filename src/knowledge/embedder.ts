import type { MastraEmbeddingModel } from '@mastra/core/vector';

type OllamaEmbeddingModel = Extract<MastraEmbeddingModel<string>, { specificationVersion: 'v3' }>;

// Embeddings come from the local OpenAI-compatible Ollama endpoint, so no hosted API is needed.
export const embeddingModelName = process.env.KNOWLEDGE_EMBED_MODEL || 'nomic-embed-text';
export const embeddingDimension = Number(process.env.KNOWLEDGE_EMBED_DIM || 768);

const embeddingApi = (process.env.KNOWLEDGE_EMBED_API || process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const maxEmbeddingsPerCall = 16;

// Knowledge uses one embedder for writes and queries, so no task prefixes are added here.
export function createOllamaEmbedder(fetchImpl: typeof fetch = fetch): OllamaEmbeddingModel {
  return {
    specificationVersion: 'v3',
    provider: 'ollama',
    modelId: embeddingModelName,
    maxEmbeddingsPerCall,
    supportsParallelCalls: false,
    async doEmbed({ values, abortSignal, headers }) {
      const response = await fetchImpl(`${embeddingApi}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.ASSISTANT_API_KEY || 'ollama'}`,
          ...headers,
        },
        body: JSON.stringify({ model: embeddingModelName, input: values }),
        signal: abortSignal,
      });
      if (!response.ok) {
        throw new Error(`Embedding request failed with HTTP ${response.status}. Check that Ollama runs and "${embeddingModelName}" is pulled.`);
      }
      const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
      const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== values.length) throw new Error('Embedding response has the wrong number of vectors.');
      for (const item of data) {
        if (item.embedding.length !== embeddingDimension) {
          throw new Error(`Embedding has ${item.embedding.length} dimensions; expected ${embeddingDimension}. Set KNOWLEDGE_EMBED_DIM.`);
        }
      }
      return { embeddings: data.map((item) => item.embedding), warnings: [] };
    },
  } as OllamaEmbeddingModel;
}
