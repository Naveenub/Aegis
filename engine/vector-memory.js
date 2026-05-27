import OpenAI from 'openai';
import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const redis   = new IORedis();

const VECTOR_DIM = 1536;

// How long a memory entry lives before it is eligible for eviction.
// Override via env: AEGIS_MEMORY_TTL_DAYS (default: 30 days)
const MEMORY_TTL_MS = parseInt(process.env.AEGIS_MEMORY_TTL_DAYS ?? '30') * 24 * 60 * 60 * 1000;

// Redis EXPIRE on the hash key, in seconds (must be >= TTL_MS / 1000).
// We set it 10 % longer so the sorted-set eviction pass always runs before
// Redis itself deletes the key, keeping the index consistent.
const REDIS_EXPIRE_S = Math.ceil(MEMORY_TTL_MS / 1000 * 1.1);

// Sorted-set that tracks all memory keys for a tenant, scored by storedAt (ms).
// Used for efficient range-delete during eviction without a full FT.SEARCH scan.
function ageIndexKey(tenantId) {
  return `aegis:memory:age:${tenantId}`;
}

function indexName(tenantId) {
  return `aegis_memory_${tenantId.replace(/-/g, '_')}`;
}

function memoryPrefix(tenantId) {
  return `memory:${tenantId}:`;
}

// ─── Index init ───────────────────────────────────────────────────────────────

/**
 * Create the RediSearch vector index for a tenant (idempotent).
 * Also runs an eviction pass on startup to clear any stale entries that
 * accumulated while the process was down.
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
        'text',     'TEXT',
        'patch',    'TEXT',
        'storedAt', 'NUMERIC', 'SORTABLE',
        'vector',   'VECTOR', 'HNSW', '6',
          'TYPE', 'FLOAT32',
          'DIM',  VECTOR_DIM,
          'DISTANCE_METRIC', 'COSINE'
    );
  } catch {
    // index already exists — fine
  }

  // Clear expired entries from before this process started
  await evictExpiredMemory(tenantId);
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

/**
 * Store a memory entry with a TTL.
 *
 * Two expiry mechanisms work together:
 *   1. Redis EXPIRE on the hash key  — hard eviction by Redis itself.
 *   2. Sorted-set age index          — lets evictExpiredMemory() do a fast
 *      range-delete without scanning the whole keyspace.
 */
export async function storeMemory(text, patch, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const vector   = await embed(text);
  const storedAt = Date.now();
  const id       = `${memoryPrefix(tenantId)}${storedAt}_${Math.random().toString(36).slice(2, 7)}`;

  const pipeline = redis.pipeline();

  // Store the hash
  pipeline.hset(id, {
    text,
    patch,
    storedAt: String(storedAt),
    vector: Buffer.from(new Float32Array(vector).buffer)
  });

  // Hard TTL: Redis will delete the key automatically after this
  pipeline.expire(id, REDIS_EXPIRE_S);

  // Track in the age index (score = storedAt ms) for fast eviction scans
  pipeline.zadd(ageIndexKey(tenantId), storedAt, id);

  // Also expire the age-index entry (soft — we clean it during eviction too)
  pipeline.expireat(
    ageIndexKey(tenantId),
    Math.ceil((storedAt + REDIS_EXPIRE_S * 1000) / 1000)
  );

  await pipeline.exec();
}

// ─── Eviction ────────────────────────────────────────────────────────────────

/**
 * Delete all memory entries older than MEMORY_TTL_MS for a tenant.
 *
 * Safe to call at any time — idempotent, non-blocking for search.
 * Called automatically by initVectorIndex() and can be called by a cron job:
 *
 *   import { evictExpiredMemory } from './engine/vector-memory.js';
 *   setInterval(() => evictExpiredMemory(), 60 * 60 * 1000); // hourly
 *
 * @param {string} tenantId
 * @returns {number} count of entries deleted
 */
export async function evictExpiredMemory(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const cutoff  = Date.now() - MEMORY_TTL_MS;
  const ageKey  = ageIndexKey(tenantId);

  // All keys in the age index whose storedAt score is older than cutoff
  const expired = await redis.zrangebyscore(ageKey, '-inf', cutoff);
  if (!expired.length) return 0;

  const pipeline = redis.pipeline();
  for (const key of expired) {
    pipeline.del(key);
  }
  // Remove the evicted members from the age index in one call
  pipeline.zremrangebyscore(ageKey, '-inf', cutoff);
  await pipeline.exec();

  return expired.length;
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
    'RETURN', '4', 'text', 'patch', 'score', 'storedAt',
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