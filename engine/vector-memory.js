import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

// ─── OpenAI client — optional ─────────────────────────────────────────────────
// Resolved lazily so a missing OPENAI_API_KEY (or absent 'openai' package)
// never crashes the module at import time. Returns null when unavailable.
let _clientPromise = null;

async function getOpenAIClient() {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    if (!process.env.OPENAI_API_KEY) return null;
    try {
      const { default: OpenAI } = await import('openai');
      return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } catch {
      return null;
    }
  })();
  return _clientPromise;
}

const redis = new IORedis();

const VECTOR_DIM = 1536;

// How long a memory entry lives before it is eligible for eviction.
// Override via env: AEGIS_MEMORY_TTL_DAYS (default: 30 days)
const MEMORY_TTL_MS = parseInt(process.env.AEGIS_MEMORY_TTL_DAYS ?? '30') * 24 * 60 * 60 * 1000;

// Redis EXPIRE on the hash key, in seconds (must be >= TTL_MS / 1000).
// We set it 10 % longer so the sorted-set eviction pass always runs before
// Redis itself deletes the key, keeping the index consistent.
const REDIS_EXPIRE_S = Math.ceil(MEMORY_TTL_MS / 1000 * 1.1);

// How often the eviction cron sweeps all registered tenants.
// Override via env: AEGIS_EVICTION_INTERVAL_HOURS (default: 1 hour)
const EVICTION_INTERVAL_MS =
  parseFloat(process.env.AEGIS_EVICTION_INTERVAL_HOURS ?? '1') * 60 * 60 * 1000;

// Reranking: how many raw KNN candidates to fetch before quality scoring.
// A larger overFetch catches more relevant results at the cost of more
// embedding comparisons; 3x topK is a good default.
// Override via env: AEGIS_MEMORY_OVERFETCH (default: 3)
const OVERFETCH_FACTOR = Math.max(1, parseInt(process.env.AEGIS_MEMORY_OVERFETCH ?? '3'));

// Minimum combined quality score [0-1] a candidate must reach to be returned.
// Quality = 0.6 x similarity + 0.4 x recencyScore (exponential decay, half-life 7 days).
// Override via env: AEGIS_MEMORY_MIN_SCORE (default: 0.5)
const MIN_QUALITY_SCORE = parseFloat(process.env.AEGIS_MEMORY_MIN_SCORE ?? '0.5');

// Recency decay half-life in days. Entries older than this score 0.5 on
// recency; entries fresher than this score closer to 1.0.
// Override via env: AEGIS_MEMORY_HALFLIFE_DAYS (default: 7)
const RECENCY_HALFLIFE_MS =
  parseFloat(process.env.AEGIS_MEMORY_HALFLIFE_DAYS ?? '7') * 24 * 60 * 60 * 1000;

// ─── Tenant registry ─────────────────────────────────────────────────────────
// Tracks every tenantId that has called initVectorIndex() so the eviction
// cron can sweep all active tenants without needing external configuration.
const _activeTenants = new Set();

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

  // Register this tenant so the eviction cron covers it automatically
  _activeTenants.add(tenantId);

  // Clear expired entries from before this process started
  await evictExpiredMemory(tenantId);

  // Start the eviction cron the first time any tenant is initialised.
  // The cron is a single shared interval that sweeps all active tenants.
  startEvictionCron();
}

// ─── Eviction cron ────────────────────────────────────────────────────────────

let _evictionCronStarted = false;

/**
 * Start a single long-lived setInterval that calls evictExpiredMemory()
 * for every registered tenant on a configurable cadence.
 *
 * Safe to call multiple times — only the first call has any effect.
 * The timer is unreffed so it never prevents the process from exiting
 * cleanly (same pattern as how Node's built-in timers work in test runners).
 */
function startEvictionCron() {
  if (_evictionCronStarted) return;
  _evictionCronStarted = true;

  const timer = setInterval(async () => {
    for (const tid of _activeTenants) {
      try {
        const count = await evictExpiredMemory(tid);
        if (count > 0) {
          console.log(`[vector-memory] eviction cron: removed ${count} stale entries for tenant "${tid}"`);
        }
      } catch (err) {
        // Log but never let one tenant's failure break the cron for others
        console.error(`[vector-memory] eviction cron error for tenant "${tid}":`, err.message);
      }
    }
  }, EVICTION_INTERVAL_MS);

  // Unref so the cron timer does not keep the process alive in test / CLI contexts
  if (typeof timer.unref === 'function') timer.unref();
}

// ─── Embedding ────────────────────────────────────────────────────────────────

/**
 * Returns a Float32 embedding vector, or null when:
 *   - OPENAI_API_KEY is not set
 *   - the 'openai' package is not installed
 *   - the API call fails for any reason (network, quota, invalid key, etc.)
 *
 * Callers must handle null — they degrade gracefully rather than throwing.
 *
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
async function embed(text) {
  const client = await getOpenAIClient();
  if (!client) return null;
  try {
    const res = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text
    });
    return res.data[0].embedding;
  } catch (err) {
    console.warn('[vector-memory] embed() failed — memory features disabled for this call:', err.message);
    return null;
  }
}

// ─── Capability probe ─────────────────────────────────────────────────────────

/**
 * getVectorCapabilities()
 *
 * Probes both the OpenAI key and the Redis Stack RediSearch module and returns
 * a structured object describing what is available.  Called at boot time and
 * on GET /health so operators get an immediate, unambiguous signal instead of
 * discovering the degradation from a missing context window hours into a run.
 *
 * Redis Stack check: issue `FT._LIST` (list all indexes).  This command is
 * only available when the RediSearch module is loaded.  Vanilla Redis returns
 * an ERR_UNKNOWN_COMMAND error; we catch that and set redisSearch=false.
 *
 * @returns {Promise<{
 *   openai:      boolean,   // OPENAI_API_KEY set and openai package importable
 *   redisSearch: boolean,   // RediSearch module present in the connected Redis
 *   embeddings:  boolean,   // both required deps available (openai && redisSearch)
 *   warnings:    string[]   // human-readable explanation of each missing dep
 * }>}
 */
export async function getVectorCapabilities() {
  const warnings = [];

  // ── 1. OpenAI key + package ───────────────────────────────────────────────
  const openaiClient = await getOpenAIClient();
  const openai = openaiClient !== null;
  if (!openai) {
    if (!process.env.OPENAI_API_KEY) {
      warnings.push(
        'OPENAI_API_KEY is not set — vector memory embeddings are disabled. ' +
        'Agents will run without past-fix context. ' +
        'Set OPENAI_API_KEY in your .env to enable semantic memory search.'
      );
    } else {
      warnings.push(
        'The "openai" npm package could not be loaded — run `npm install openai`. ' +
        'Vector memory embeddings are disabled until the package is available.'
      );
    }
  }

  // ── 2. RediSearch module (Redis Stack) ────────────────────────────────────
  let redisSearch = false;
  try {
    // FT._LIST lists all RediSearch indexes. It only exists when the module is loaded.
    await redis.call('FT._LIST');
    redisSearch = true;
  } catch (err) {
    // ERR_UNKNOWN_COMMAND → module absent. Any other error is a transient
    // Redis issue and should not be treated as a permanent capability gap.
    const isUnknownCommand =
      err.message?.includes('ERR unknown command') ||
      err.message?.includes('unknown command') ||
      err.message?.includes('NOSCRIPT');

    if (isUnknownCommand) {
      warnings.push(
        'Redis Stack (RediSearch module) is not available — vector memory search is disabled. ' +
        'The connected Redis instance is vanilla Redis. ' +
        'Upgrade to Redis Stack to enable semantic memory:\n' +
        '  docker run -p 6379:6379 redis/redis-stack-server:latest\n' +
        'Without Redis Stack, past-fix context will never be surfaced to agents.'
      );
    } else {
      // Transient error — flag it but don't permanently mark redisSearch false.
      // A restart may resolve it; we don't want to kill the health check permanently.
      warnings.push(
        `Redis Stack probe returned an unexpected error (may be transient): ${err.message}`
      );
      // Optimistically treat as available so we don't mask a momentary blip
      redisSearch = true;
    }
  }

  const embeddings = openai && redisSearch;

  return { openai, redisSearch, embeddings, warnings };
}

/**
 * logVectorCapabilityWarnings()
 *
 * Convenience wrapper for boot-time logging: runs the capability probe and
 * prints each warning to stderr with a clear [vector-memory] prefix so it
 * cannot be missed in the server startup log.
 *
 * Called once at server startup and once after each tenant registration so
 * new environments surface the issue immediately.
 */
export async function logVectorCapabilityWarnings() {
  const caps = await getVectorCapabilities();
  for (const w of caps.warnings) {
    console.warn(`[vector-memory] ⚠️  ${w}`);
  }
  if (!caps.embeddings) {
    console.warn(
      '[vector-memory] ℹ️  Vector memory is DEGRADED. ' +
      'Workflows will still run — agents simply receive no past-fix context. ' +
      'See README § "Vector Memory (Redis Stack + OpenAI)" for setup instructions.'
    );
  }
  return caps;
}



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

  const vector = await embed(text);
  if (!vector) {
    // Embeddings unavailable (no API key or call failed) — skip storage silently.
    // The agent run still succeeds; it just won't seed the memory index.
    return null;
  }

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

/**
 * Compute an exponential recency score in [0, 1].
 * score = 2^(-age / halfLife)  →  1.0 when age=0, 0.5 at age=halfLife, ~0 when very old.
 */
function recencyScore(storedAtMs) {
  const ageMs = Date.now() - storedAtMs;
  return Math.pow(2, -ageMs / RECENCY_HALFLIFE_MS);
}

/**
 * Search memory and return the top-K results ranked by a combined quality score.
 *
 * Algorithm:
 *   1. Over-fetch: ask RediSearch for topK * OVERFETCH_FACTOR raw KNN candidates.
 *      This widens the candidate pool so the reranker has good material to sort.
 *   2. Rerank: for each candidate compute
 *        qualityScore = 0.6 * cosineSimilarity + 0.4 * recencyScore
 *      where recencyScore decays exponentially with a configurable half-life.
 *   3. Filter: drop any candidate below MIN_QUALITY_SCORE.
 *   4. Sort descending by qualityScore and return the top topK entries.
 *
 * This replaces the old flat cosine >= 0.75 cut, which had two problems:
 *   - A hard threshold discards genuinely useful results just below the line.
 *   - It gave equal rank to a fresh result and a month-old one with the same
 *     cosine score, so stale memories polluted the context window.
 *
 * Note: RediSearch returns cosine *distance* (lower = more similar) when the
 * index uses DISTANCE_METRIC COSINE. We convert: similarity = 1 - distance.
 *
 * @param {string} query
 * @param {number} topK      - max results to return after reranking
 * @param {string} tenantId
 * @returns {object[]}       - sorted by qualityScore desc, each entry has
 *                             { text, patch, storedAt, similarity, recency, qualityScore }
 */
export async function searchMemory(query, topK = 3, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const queryVec = await embed(query);
  if (!queryVec) {
    // Embeddings unavailable — return empty results so the agent runs without
    // past-fix context rather than throwing and aborting the whole workflow.
    return [];
  }

  const idx        = indexName(tenantId);
  const fetchCount = topK * OVERFETCH_FACTOR;

  const res = await redis.call(
    'FT.SEARCH', idx,
    `*=>[KNN ${fetchCount} @vector $vec AS __dist]`,
    'PARAMS', '2', 'vec',
    Buffer.from(new Float32Array(queryVec).buffer),
    'SORTBY', '__dist',
    'RETURN', '5', 'text', 'patch', 'storedAt', '__dist', 'score',
    'DIALECT', '2'
  );

  // Parse the flat FT.SEARCH response into objects
  const candidates = [];
  for (let i = 1; i < res.length; i += 2) {
    const fields = res[i + 1];
    const item   = {};
    for (let j = 0; j < fields.length; j += 2) {
      item[fields[j]] = fields[j + 1];
    }
    candidates.push(item);
  }

  // Rerank: compute combined quality score for each candidate
  const now = Date.now();
  const ranked = candidates
    .map(item => {
      // RediSearch COSINE distance in [0, 2]; convert to similarity in [0, 1]
      const distance   = parseFloat(item.__dist ?? '1');
      const similarity = Math.max(0, 1 - distance);
      const recency    = recencyScore(parseInt(item.storedAt ?? '0', 10));
      const qualityScore = 0.6 * similarity + 0.4 * recency;

      return {
        text:    item.text,
        patch:   item.patch,
        storedAt: item.storedAt,
        similarity,
        recency,
        qualityScore
      };
    })
    .filter(item => item.qualityScore >= MIN_QUALITY_SCORE)  // drop low-quality
    .sort((a, b) => b.qualityScore - a.qualityScore)          // best first
    .slice(0, topK);                                           // hard top-K cap

  return ranked;
}
