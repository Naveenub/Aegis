import OpenAI from 'openai';
import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis   = new IORedis();

const VECTOR_DIM = 1536;

// ─── Tenant-scoped helpers ────────────────────────────────────────────────────
// Each tenant gets their own RediSearch index and their own key prefix so
// memory from one tenant is never surfaced to another.

function indexName(tenantId) {
  // RediSearch index names must be alphanumeric + underscores
  return `aegis_memory_${tenantId.replace(/-/g, '_')}`;
}

function memoryPrefix(tenantId) {
  return `memory:${tenantId}:`;
}

// ─── Index init ───────────────────────────────────────────────────────────────

/**
 * Create the vector index for a specific tenant (idempotent — safe to call on
 * every server start). Call once per tenant on first use.
 */
export async function initVectorIndex(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const idx    = indexName(tenantId);
  const prefix = memoryPrefix(tenantId);

  try {
    await redis.call(
      'FT.CREATE', idx,
      'ON', 'HASH',
      'PREFIX', '1', prefix,
      'SCHEMA',
        'text',   'TEXT',
        'patch',  'TEXT',
        'vector', 'VECTOR', 'HNSW', '6',
          'TYPE', 'FLOAT32',
          'DIM',  VECTOR_DIM,
          'DISTANCE_METRIC', 'COSINE'
    );
  } catch {
    // index already exists — fine
  }
}

// ─── Embedding ────────────────────────────────────────────────────────────────

async function embed(text) {
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text
  });
  return res.data[0].embedding;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export async function storeMemory(text, patch, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const vector = await embed(text);
  const id     = `${memoryPrefix(tenantId)}${Date.now()}`;

  await redis.hset(id, {
    text,
    patch,
    vector: Buffer.from(new Float32Array(vector).buffer)
  });
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchMemory(query, topK = 3, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const queryVec = await embed(query);
  const idx      = indexName(tenantId);

  const res = await redis.call(
    'FT.SEARCH', idx,
    `*=>[KNN ${topK} @vector $vec AS score]`,
    'PARAMS', '2', 'vec',
    Buffer.from(new Float32Array(queryVec).buffer),
    'SORTBY', 'score',
    'RETURN', '3', 'text', 'patch', 'score',
    'DIALECT', '2'
  );

  const results = [];
  for (let i = 1; i < res.length; i += 2) {
    const doc  = res[i + 1];
    const item = {};
    for (let j = 0; j < doc.length; j += 2) {
      item[doc[j]] = doc[j + 1];
    }
    results.push(item);
  }

  // Quality filter: drop low-similarity matches
  return results.filter(r => parseFloat(r.score) >= 0.75);
}