// Embeddings come from the local OpenAI-compatible Ollama endpoint, so no hosted API is needed.
export const embeddingModel = process.env.KNOWLEDGE_EMBED_MODEL || 'nomic-embed-text';
export const embeddingDimension = Number(process.env.KNOWLEDGE_EMBED_DIM || 768);

const embeddingApi = (process.env.KNOWLEDGE_EMBED_API || process.env.ASSISTANT_API || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const batchSize = 16;

// nomic-embed-text was trained with task prefixes; using them improves retrieval.
export const documentPrefix = 'search_document: ';
export const queryPrefix = 'search_query: ';

export async function embedTexts(texts: string[], prefix: string): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((text) => `${prefix}${text}`);
    const response = await fetch(`${embeddingApi}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.ASSISTANT_API_KEY || 'ollama'}`,
      },
      body: JSON.stringify({ model: embeddingModel, input: batch }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed with HTTP ${response.status}. Check that Ollama runs and "${embeddingModel}" is pulled.`);
    }
    const body = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
    const data = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (data.length !== batch.length) throw new Error('Embedding response has the wrong number of vectors.');
    for (const item of data) {
      if (item.embedding.length !== embeddingDimension) {
        throw new Error(`Embedding has ${item.embedding.length} dimensions; expected ${embeddingDimension}. Set KNOWLEDGE_EMBED_DIM.`);
      }
      vectors.push(item.embedding);
    }
  }
  return vectors;
}
