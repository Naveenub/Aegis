import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

// ─── OpenAI client — optional ─────────────────────────────────────────────────
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

const MEMORY_TTL_MS = parseInt(process.env.AEGIS_MEMORY_TTL_DAYS ?? '30') * 24 * 60 * 60 * 1000;
const REDIS_EXPIRE_S = Math.ceil(MEMORY_TTL_MS / 1000 * 1.1);
const EVICTION_INTERVAL_MS =
  parseFloat(process.env.AEGIS_EVICTION_INTERVAL_HOURS ?? '1') * 60 * 60 * 1000;
const OVERFETCH_FACTOR = Math.max(1, parseInt(process.env.AEGIS_MEMORY_OVERFETCH ?? '3'));
const MIN_QUALITY_SCORE = parseFloat(process.env.AEGIS_MEMORY_MIN_SCORE ?? '0.5');
const RECENCY_HALFLIFE_MS =
  parseFloat(process.env.AEGIS_MEMORY_HALFLIFE_DAYS ?? '7') * 24 * 60 * 60 * 1000;

// ─── Hybrid scoring weights ───────────────────────────────────────────────────
// Default blend: cosine 50%, BM25 30%, recency 20%.
// Override via env vars to tune without a code change:
//   AEGIS_MEMORY_W_COSINE   weight for vector cosine similarity  (default: 0.50)
//   AEGIS_MEMORY_W_BM25     weight for BM25 keyword score        (default: 0.30)
//   AEGIS_MEMORY_W_RECENCY  weight for exponential recency decay (default: 0.20)
//
// Weights are normalised at startup so they always sum to 1.0 regardless of
// what the operator sets — no need to keep them in sync manually.
const _rawW = {
  cosine:  parseFloat(process.env.AEGIS_MEMORY_W_COSINE  ?? '0.50'),
  bm25:    parseFloat(process.env.AEGIS_MEMORY_W_BM25    ?? '0.30'),
  recency: parseFloat(process.env.AEGIS_MEMORY_W_RECENCY ?? '0.20'),
};
const _wSum = _rawW.cosine + _rawW.bm25 + _rawW.recency;
const WEIGHTS = {
  cosine:  _rawW.cosine  / _wSum,
  bm25:    _rawW.bm25    / _wSum,
  recency: _rawW.recency / _wSum,
};

// ─── BM25 parameters ──────────────────────────────────────────────────────────
// k1 controls term-frequency saturation; b controls document-length normalisation.
// Okapi BM25 paper defaults (k1=1.5, b=0.75) work well for short code/text blobs.
// Override via env:
//   AEGIS_BM25_K1  (default: 1.5)
//   AEGIS_BM25_B   (default: 0.75)
const BM25_K1 = parseFloat(process.env.AEGIS_BM25_K1 ?? '1.5');
const BM25_B  = parseFloat(process.env.AEGIS_BM25_B  ?? '0.75');

// Redis key that stores the per-tenant BM25 corpus stats (IDF, avgdl).
// Format: HASH with fields  avgdl, docCount, idf:<term>
function bm25StatsKey(tenantId) {
  return `aegis:memory:bm25stats:${tenantId}`;
}

// ─── Adaptive weight feedback ─────────────────────────────────────────────────
// When a caller marks a retrieved memory as helpful or unhelpful via
// recordMemoryFeedback(), the per-tenant weights in Redis are nudged in the
// direction that produced the result.  This gives a lightweight feedback loop
// without a full offline training pipeline.
//
// Weight deltas are small (FEEDBACK_STEP) and clamped to [0.05, 0.90] so no
// single component can dominate.  The raw counts are stored separately so the
// adjustment is always proportional and can be inspected / reset.
//
// Redis key: aegis:memory:weights:{tenantId}  HASH  cosine, bm25, recency
const FEEDBACK_STEP = parseFloat(process.env.AEGIS_MEMORY_FEEDBACK_STEP ?? '0.02');
const WEIGHT_MIN    = 0.05;
const WEIGHT_MAX    = 0.90;

function weightKey(tenantId) {
  return `aegis:memory:weights:${tenantId}`;
}

/**
 * Load per-tenant learned weights from Redis, falling back to the normalised
 * env-var defaults when no feedback has been recorded yet.
 */
async function loadWeights(tenantId) {
  try {
    const stored = await redis.hgetall(weightKey(tenantId));
    if (stored && stored.cosine && stored.bm25 && stored.recency) {
      return {
        cosine:  parseFloat(stored.cosine),
        bm25:    parseFloat(stored.bm25),
        recency: parseFloat(stored.recency),
      };
    }
  } catch {
    // Redis error — fall through to defaults
  }
  return { ...WEIGHTS };
}

/**
 * Record whether the top-ranked memory retrieved with a given component mix
 * was helpful.  Nudges that component's weight up or down by FEEDBACK_STEP
 * and persists the new weights for this tenant.
 *
 * @param {string} tenantId
 * @param {'cosine'|'bm25'|'recency'} leadingComponent  - which signal ranked this result first
 * @param {boolean} helpful                              - true = reinforce, false = penalise
 */
export async function recordMemoryFeedback(tenantId, leadingComponent, helpful) {
  assertTenantId(tenantId);
  const w = await loadWeights(tenantId);

  if (!(leadingComponent in w)) return; // guard against bad caller input

  const delta = helpful ? +FEEDBACK_STEP : -FEEDBACK_STEP;
  w[leadingComponent] = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w[leadingComponent] + delta));

  // Renormalise so the three weights always sum to 1.0
  const sum = w.cosine + w.bm25 + w.recency;
  w.cosine  = w.cosine  / sum;
  w.bm25    = w.bm25    / sum;
  w.recency = w.recency / sum;

  await redis.hset(weightKey(tenantId), {
    cosine:  String(w.cosine),
    bm25:    String(w.bm25),
    recency: String(w.recency),
  });
}

// ─── Tenant registry ─────────────────────────────────────────────────────────
const _activeTenants = new Set();

function ageIndexKey(tenantId)  { return `aegis:memory:age:${tenantId}`; }
function indexName(tenantId)    { return `aegis_memory_${tenantId.replace(/-/g, '_')}`; }
function memoryPrefix(tenantId) { return `memory:${tenantId}:`; }

// ─── Index init ───────────────────────────────────────────────────────────────

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
        'termFreq', 'TEXT',           // space-separated "term:count" pairs for BM25
        'docLen',   'NUMERIC',        // token count for BM25 length normalisation
        'vector',   'VECTOR', 'HNSW', '6',
          'TYPE', 'FLOAT32',
          'DIM',  VECTOR_DIM,
          'DISTANCE_METRIC', 'COSINE'
    );
  } catch {
    // index already exists — fine
  }

  _activeTenants.add(tenantId);
  await evictExpiredMemory(tenantId);
  startEvictionCron();
}

// ─── Eviction cron ────────────────────────────────────────────────────────────

let _evictionCronStarted = false;

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
        console.error(`[vector-memory] eviction cron error for tenant "${tid}":`, err.message);
      }
    }
  }, EVICTION_INTERVAL_MS);

  if (typeof timer.unref === 'function') timer.unref();
}

// ─── Embedding ────────────────────────────────────────────────────────────────

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

// ─── BM25 helpers ─────────────────────────────────────────────────────────────

/**
 * Tokenise text into lowercase alphanumeric terms, filtering stop-words.
 * This mirrors what is stored at index time so IDF counts are consistent.
 */
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','can','that',
  'this','these','those','it','its','not','no','by','from','as','if','then',
]);

function tokenise(text) {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Build a term-frequency map from an array of tokens.
 * @returns {Map<string, number>}
 */
function buildTF(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Serialise a TF map to a space-separated "term:count" string for Redis storage.
 * Example: "fix:3 null:2 pointer:1"
 */
function serialiseTF(tf) {
  return [...tf.entries()].map(([t, c]) => `${t}:${c}`).join(' ');
}

/**
 * Deserialise the stored "term:count" string back to a Map.
 */
function deserialiseTF(str) {
  const tf = new Map();
  for (const pair of (str ?? '').split(' ')) {
    const idx = pair.lastIndexOf(':');
    if (idx < 1) continue;
    const term  = pair.slice(0, idx);
    const count = parseInt(pair.slice(idx + 1), 10);
    if (term && !isNaN(count)) tf.set(term, count);
  }
  return tf;
}

/**
 * Update per-tenant BM25 corpus statistics (IDF numerators and avgdl).
 *
 * Called inside storeMemory() after writing the document hash.  Uses Redis
 * HINCRBY so concurrent writes are safe without any additional locking.
 *
 * Stats stored:
 *   docCount          — total documents in the corpus
 *   avgdl             — running average document length (approximated)
 *   idf:<term>        — number of documents containing this term (df)
 */
async function updateBM25Stats(tenantId, tf, docLen) {
  const statsKey  = bm25StatsKey(tenantId);
  const pipeline  = redis.pipeline();

  pipeline.hincrbyfloat(statsKey, 'docCount', 1);
  // Running avgdl approximation: store cumulative length, divide on read.
  pipeline.hincrbyfloat(statsKey, 'totalLen', docLen);

  // Increment df (document frequency) for each unique term in this document
  for (const term of tf.keys()) {
    pipeline.hincrbyfloat(statsKey, `idf:${term}`, 1);
  }

  await pipeline.exec();
}

/**
 * Compute IDF (inverse document frequency) scores for a set of query terms
 * using the stored corpus statistics.
 *
 * IDF(t) = log((N - df(t) + 0.5) / (df(t) + 0.5) + 1)   [Robertson IDF]
 *
 * @param {string}   tenantId
 * @param {string[]} queryTerms
 * @returns {Promise<Map<string, number>>}  term → IDF score
 */
async function computeIDF(tenantId, queryTerms) {
  if (!queryTerms.length) return new Map();

  const statsKey = bm25StatsKey(tenantId);
  const pipe     = redis.pipeline();

  pipe.hget(statsKey, 'docCount');
  pipe.hget(statsKey, 'totalLen');
  for (const t of queryTerms) pipe.hget(statsKey, `idf:${t}`);

  const results  = await pipe.exec();
  const docCount = parseFloat(results[0][1] ?? '1');
  const totalLen = parseFloat(results[1][1] ?? '1');
  const avgdl    = totalLen / Math.max(docCount, 1);

  const idfMap = new Map();
  for (let i = 0; i < queryTerms.length; i++) {
    const df  = parseFloat(results[2 + i][1] ?? '0');
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(queryTerms[i], idf);
  }

  return idfMap;
}

/**
 * Compute the BM25 score for a single document against query terms.
 *
 * BM25(d,q) = Σ IDF(t) * (tf(t,d) * (k1+1)) / (tf(t,d) + k1*(1 - b + b*|d|/avgdl))
 *
 * @param {Map<string, number>} docTF   - term frequencies in the document
 * @param {number}              docLen  - document length in tokens
 * @param {number}              avgdl   - corpus average document length
 * @param {Map<string, number>} idfMap  - pre-computed IDF scores
 * @returns {number}  raw BM25 score (not normalised)
 */
function bm25Score(docTF, docLen, avgdl, idfMap) {
  let score = 0;
  for (const [term, idf] of idfMap) {
    const tf = docTF.get(term) ?? 0;
    if (tf === 0) continue;
    const numerator   = tf * (BM25_K1 + 1);
    const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / Math.max(avgdl, 1)));
    score += idf * (numerator / denominator);
  }
  return score;
}

// ─── Capability probe ─────────────────────────────────────────────────────────

export async function getVectorCapabilities() {
  const warnings = [];

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

  let redisSearch = false;
  try {
    await redis.call('FT._LIST');
    redisSearch = true;
  } catch (err) {
    const isUnknownCommand =
      err.message?.includes('ERR unknown command') ||
      err.message?.includes('unknown command') ||
      err.message?.includes('NOSCRIPT');

    if (isUnknownCommand) {
      warnings.push(
        'Redis Stack (RediSearch module) is not available — vector memory search is disabled. ' +
        'Upgrade to Redis Stack to enable semantic memory:\n' +
        '  docker run -p 6379:6379 redis/redis-stack-server:latest\n' +
        'Without Redis Stack, past-fix context will never be surfaced to agents.'
      );
    } else {
      warnings.push(
        `Redis Stack probe returned an unexpected error (may be transient): ${err.message}`
      );
      redisSearch = true;
    }
  }

  const embeddings = openai && redisSearch;
  return { openai, redisSearch, embeddings, warnings };
}

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

// ─── Store ────────────────────────────────────────────────────────────────────

/**
 * Store a memory entry with a TTL.
 *
 * In addition to the cosine vector, we now store BM25 term-frequency data so
 * keyword signals are available at search time without a second embedding call.
 */
export async function storeMemory(text, patch, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const vector = await embed(text);
  if (!vector) return null;

  const storedAt = Date.now();
  const id       = `${memoryPrefix(tenantId)}${storedAt}_${Math.random().toString(36).slice(2, 7)}`;

  // BM25 prep
  const tokens  = tokenise(text + ' ' + patch);
  const tf      = buildTF(tokens);
  const docLen  = tokens.length;

  const pipeline = redis.pipeline();

  pipeline.hset(id, {
    text,
    patch,
    storedAt: String(storedAt),
    termFreq: serialiseTF(tf),
    docLen:   String(docLen),
    vector:   Buffer.from(new Float32Array(vector).buffer),
  });
  pipeline.expire(id, REDIS_EXPIRE_S);
  pipeline.zadd(ageIndexKey(tenantId), storedAt, id);
  pipeline.expireat(
    ageIndexKey(tenantId),
    Math.ceil((storedAt + REDIS_EXPIRE_S * 1000) / 1000)
  );

  await pipeline.exec();

  // Update IDF corpus stats (non-blocking — failure doesn't affect storage)
  updateBM25Stats(tenantId, tf, docLen).catch(err =>
    console.warn('[vector-memory] BM25 stats update failed:', err.message)
  );
}

// ─── Eviction ─────────────────────────────────────────────────────────────────

export async function evictExpiredMemory(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const cutoff = Date.now() - MEMORY_TTL_MS;
  const ageKey = ageIndexKey(tenantId);

  const expired = await redis.zrangebyscore(ageKey, '-inf', cutoff);
  if (!expired.length) return 0;

  const pipeline = redis.pipeline();
  for (const key of expired) pipeline.del(key);
  pipeline.zremrangebyscore(ageKey, '-inf', cutoff);
  await pipeline.exec();

  return expired.length;
}

// ─── Recency helper ───────────────────────────────────────────────────────────

function recencyScore(storedAtMs) {
  const ageMs = Date.now() - storedAtMs;
  return Math.pow(2, -ageMs / RECENCY_HALFLIFE_MS);
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Search memory and return the top-K results ranked by a three-way hybrid score.
 *
 * Scoring pipeline
 * ────────────────
 * 1. Over-fetch  — KNN retrieves topK × OVERFETCH_FACTOR raw candidates via
 *    approximate nearest-neighbour search on the vector index.
 *
 * 2. BM25        — For each candidate, compute a BM25 score against query terms
 *    using stored term-frequency data and per-tenant IDF statistics.
 *    BM25 raw scores are normalised to [0, 1] within the candidate set so they
 *    are on the same scale as cosine similarity and recency.
 *
 * 3. Hybrid score — Weighted blend of three signals:
 *      qualityScore = W_cosine  * cosineSimilarity
 *                   + W_bm25    * bm25Normalised
 *                   + W_recency * recencyScore
 *    Weights default to 0.50 / 0.30 / 0.20 and can be overridden via env vars.
 *    Per-tenant learned weights (from recordMemoryFeedback()) take precedence
 *    over the env-var defaults once any feedback has been recorded.
 *
 * 4. Filter & sort — Drop candidates below MIN_QUALITY_SCORE, sort descending,
 *    return the top topK entries.
 *
 * Each result includes cosine, bm25Normalised, recency, and qualityScore so
 * callers can inspect which signal drove the ranking and feed back via
 * recordMemoryFeedback().
 *
 * @param {string} query
 * @param {number} topK
 * @param {string} tenantId
 * @returns {object[]}
 */
export async function searchMemory(query, topK = 3, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const queryVec = await embed(query);
  if (!queryVec) return [];

  const idx        = indexName(tenantId);
  const fetchCount = topK * OVERFETCH_FACTOR;

  // ── 1. Vector KNN over-fetch ──────────────────────────────────────────────
  const res = await redis.call(
    'FT.SEARCH', idx,
    `*=>[KNN ${fetchCount} @vector $vec AS __dist]`,
    'PARAMS', '2', 'vec',
    Buffer.from(new Float32Array(queryVec).buffer),
    'SORTBY', '__dist',
    'RETURN', '7', 'text', 'patch', 'storedAt', '__dist', 'termFreq', 'docLen', 'score',
    'DIALECT', '2'
  );

  // Parse the flat FT.SEARCH response
  const candidates = [];
  for (let i = 1; i < res.length; i += 2) {
    const fields = res[i + 1];
    const item   = {};
    for (let j = 0; j < fields.length; j += 2) item[fields[j]] = fields[j + 1];
    candidates.push(item);
  }

  if (!candidates.length) return [];

  // ── 2. BM25 scoring ───────────────────────────────────────────────────────
  const queryTerms = tokenise(query);
  const idfMap     = await computeIDF(tenantId, queryTerms);

  // Fetch corpus avgdl for BM25 normalisation
  const statsKey  = bm25StatsKey(tenantId);
  const statsRaw  = await redis.hmget(statsKey, 'docCount', 'totalLen');
  const docCount  = parseFloat(statsRaw[0] ?? '1');
  const totalLen  = parseFloat(statsRaw[1] ?? '1');
  const avgdl     = totalLen / Math.max(docCount, 1);

  // Compute raw BM25 scores for all candidates
  const withScores = candidates.map(item => {
    const docTF    = deserialiseTF(item.termFreq);
    const docLen   = parseInt(item.docLen ?? '0', 10);
    const distance = parseFloat(item.__dist ?? '1');
    const cosine   = Math.max(0, 1 - distance);
    const recency  = recencyScore(parseInt(item.storedAt ?? '0', 10));
    const rawBM25  = bm25Score(docTF, docLen, avgdl, idfMap);
    return { item, cosine, recency, rawBM25 };
  });

  // ── 3. Normalise BM25 to [0, 1] within the candidate set ─────────────────
  const maxBM25 = Math.max(...withScores.map(s => s.rawBM25), 1e-9);

  // Load per-tenant learned weights (falls back to env-var defaults)
  const w = await loadWeights(tenantId);

  // ── 4. Hybrid scoring, filter, sort ──────────────────────────────────────
  const ranked = withScores
    .map(({ item, cosine, recency, rawBM25 }) => {
      const bm25Normalised = rawBM25 / maxBM25;
      const qualityScore   = w.cosine  * cosine
                           + w.bm25    * bm25Normalised
                           + w.recency * recency;

      // Identify which signal contributed most (for feedback routing)
      const contributions = [
        { component: 'cosine',  value: w.cosine  * cosine         },
        { component: 'bm25',    value: w.bm25    * bm25Normalised },
        { component: 'recency', value: w.recency * recency        },
      ];
      const leadingComponent = contributions.reduce((a, b) => a.value > b.value ? a : b).component;

      return {
        text:             item.text,
        patch:            item.patch,
        storedAt:         item.storedAt,
        similarity:       cosine,          // kept for backwards compat
        cosine,
        bm25:             bm25Normalised,
        recency,
        qualityScore,
        leadingComponent, // callers pass this to recordMemoryFeedback()
      };
    })
    .filter(item => item.qualityScore >= MIN_QUALITY_SCORE)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, topK);

  return ranked;
}
