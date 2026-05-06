import OpenAI from 'openai';
import IORedis from 'ioredis';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const redis = new IORedis();

// embedding model size = 1536
const VECTOR_DIM = 1536;
const INDEX_NAME = 'aegis_memory';

// 🔧 create index (run once)
export async function initVectorIndex() {
  try {
    await redis.call(
      'FT.CREATE',
      INDEX_NAME,
      'ON', 'HASH',
      'PREFIX', '1', 'memory:',
      'SCHEMA',
      'text', 'TEXT',
      'patch', 'TEXT',
      'vector', 'VECTOR', 'HNSW', '6',
      'TYPE', 'FLOAT32',
      'DIM', VECTOR_DIM,
      'DISTANCE_METRIC', 'COSINE'
    );
  } catch (err) {
    // index already exists
  }
}

// 🧠 embedding
async function embed(text) {
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });

  return res.data[0].embedding;
}

// ➕ store
export async function storeMemory(text, patch) {
  const vector = await embed(text);

  const id = `memory:${Date.now()}`;

  await redis.hset(id, {
    text,
    patch,
    vector: Buffer.from(new Float32Array(vector).buffer)
  });
}

// 🔍 search
export async function searchMemory(query, topK = 3) {
  const queryVec = await embed(query);

  const res = await redis.call(
    'FT.SEARCH',
    INDEX_NAME,
    `*=>[KNN ${topK} @vector $vec AS score]`,
    'PARAMS', '2', 'vec',
    Buffer.from(new Float32Array(queryVec).buffer),
    'SORTBY', 'score',
    'RETURN', '3', 'text', 'patch', 'score',
    'DIALECT', '2'
  );

  const results = [];

  for (let i = 1; i < res.length; i += 2) {
    const doc = res[i + 1];

    const item = {};
    for (let j = 0; j < doc.length; j += 2) {
      item[doc[j]] = doc[j + 1];
    }

    results.push(item);
  }

  return results;
}
