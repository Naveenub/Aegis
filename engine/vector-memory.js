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
const BM25_K1 = parseFloat(process.env.AEGIS_BM25_K1 ?? '1.5');
const BM25_B  = parseFloat(process.env.AEGIS_BM25_B  ?? '0.75');

function bm25StatsKey(tenantId) {
  return `aegis:memory:bm25stats:${tenantId}`;
}

// ─── Redis Stack capability cache ─────────────────────────────────────────────
// Probed lazily on first use via _probeRedisSearch().  Once set, the value is
// never reset during the process lifetime — Redis Stack availability does not
// change at runtime.
//
// null  = not yet probed
// true  = FT.* commands are available
// false = plain Redis — HSCAN fallback path is used instead
let _redisSearchAvailable = null;

async function _probeRedisSearch() {
  if (_redisSearchAvailable !== null) return _redisSearchAvailable;
  try {
    await redis.call('FT._LIST');
    _redisSearchAvailable = true;
  } catch (err) {
    const isUnknown =
      err.message?.includes('ERR unknown command') ||
      err.message?.includes('unknown command');
    _redisSearchAvailable = !isUnknown;
    if (!_redisSearchAvailable) {
      console.warn(
        '[vector-memory] ⚠️  Redis Stack (RediSearch) is not available — ' +
        'falling back to HSCAN-based brute-force cosine search.\n' +
        '  Semantic search will work but is O(n) and does not scale beyond ~10 k entries.\n' +
        '  Upgrade to Redis Stack for production:\n' +
        '    docker run -p 6379:6379 redis/redis-stack-server:latest'
      );
    }
  }
  return _redisSearchAvailable;
}

// ─── Adaptive weight feedback ─────────────────────────────────────────────────
const FEEDBACK_STEP = parseFloat(process.env.AEGIS_MEMORY_FEEDBACK_STEP ?? '0.02');
const WEIGHT_MIN    = 0.05;
const WEIGHT_MAX    = 0.90;

function weightKey(tenantId) {
  return `aegis:memory:weights:${tenantId}`;
}

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

export async function recordMemoryFeedback(tenantId, leadingComponent, helpful) {
  assertTenantId(tenantId);
  const w = await loadWeights(tenantId);

  if (!(leadingComponent in w)) return;

  const delta = helpful ? +FEEDBACK_STEP : -FEEDBACK_STEP;
  w[leadingComponent] = Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w[leadingComponent] + delta));

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

  // Probe first so we know what Redis supports before trying FT.CREATE.
  const hasSearch = await _probeRedisSearch();

  if (hasSearch) {
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
          'termFreq', 'TEXT',
          'docLen',   'NUMERIC',
          'vector',   'VECTOR', 'HNSW', '6',
            'TYPE', 'FLOAT32',
            'DIM',  VECTOR_DIM,
            'DISTANCE_METRIC', 'COSINE'
      );
    } catch (err) {
      // "Index already exists" is normal on restart — silently continue.
      // Any other error (permissions, OOM, schema change) is worth surfacing.
      const alreadyExists =
        err.message?.includes('Index already exists') ||
        err.message?.includes('already exists');
      if (!alreadyExists) {
        console.warn(`[vector-memory] FT.CREATE warning for tenant "${tenantId}":`, err.message);
      }
    }
  }
  // When Redis Stack is absent we still register the tenant and run eviction —
  // hashes are stored on plain Redis and the HSCAN fallback handles search.

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

function buildTF(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function serialiseTF(tf) {
  return [...tf.entries()].map(([t, c]) => `${t}:${c}`).join(' ');
}

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

async function updateBM25Stats(tenantId, tf, docLen) {
  const statsKey  = bm25StatsKey(tenantId);
  const pipeline  = redis.pipeline();

  pipeline.hincrbyfloat(statsKey, 'docCount', 1);
  pipeline.hincrbyfloat(statsKey, 'totalLen', docLen);

  for (const term of tf.keys()) {
    pipeline.hincrbyfloat(statsKey, `idf:${term}`, 1);
  }

  await pipeline.exec();
}

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
  void totalLen; // avgdl is used by bm25Score via _rerank, not here

  const idfMap = new Map();
  for (let i = 0; i < queryTerms.length; i++) {
    const df  = parseFloat(results[2 + i][1] ?? '0');
    const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
    idfMap.set(queryTerms[i], idf);
  }

  return idfMap;
}

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

// ─── In-process cosine similarity ─────────────────────────────────────────────
// Used by the HSCAN fallback path when Redis Stack is not available.

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── HSCAN fallback search ────────────────────────────────────────────────────
// When Redis Stack is absent, scan all hash keys for this tenant and rank them
// in-process using cosine similarity + BM25 + recency.  This is O(n) and not
// suitable for large corpora, but it keeps the system functional with plain Redis.

async function _hscanSearch(tenantId, queryVec, _topK) {
  const prefix = memoryPrefix(tenantId);
  const candidates = [];

  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = nextCursor;

    if (!keys.length) continue;

    // Fetch all fields for each matching key in parallel
    const fetched = await Promise.all(
      keys.map(async (key) => {
        try {
          return { key, fields: await redis.hgetall(key) };
        } catch {
          return null;
        }
      })
    );

    for (const hit of fetched) {
      if (!hit?.fields?.vector || !hit.fields.storedAt) continue;

      // Deserialise the stored Float32 vector buffer back to a number array
      let storedVec;
      try {
        const buf = Buffer.isBuffer(hit.fields.vector)
          ? hit.fields.vector
          : Buffer.from(hit.fields.vector, 'binary');
        const fa = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        storedVec = Array.from(fa);
      } catch {
        continue; // corrupt entry — skip
      }

      if (storedVec.length !== VECTOR_DIM) continue;

      candidates.push({
        text:     hit.fields.text     ?? '',
        patch:    hit.fields.patch    ?? '',
        storedAt: hit.fields.storedAt ?? '0',
        termFreq: hit.fields.termFreq ?? '',
        docLen:   hit.fields.docLen   ?? '0',
        cosine:   cosineSimilarity(queryVec, storedVec),
      });
    }
  } while (cursor !== '0');

  return candidates;
}

// ─── Capability probe (public) ────────────────────────────────────────────────

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

  const redisSearch = await _probeRedisSearch();
  if (!redisSearch) {
    warnings.push(
      'Redis Stack (RediSearch module) is not available — using HSCAN brute-force fallback. ' +
      'Search is functional but O(n); upgrade to Redis Stack for production:\n' +
      '  docker run -p 6379:6379 redis/redis-stack-server:latest\n' +
      'Without Redis Stack, past-fix context is surfaced via full-scan cosine search.'
    );
  }

  const embeddings = openai; // embeddings depend only on the OpenAI client,
                             // not on Redis Stack — HSCAN fallback still embeds
  return { openai, redisSearch, embeddings, warnings };
}

export async function logVectorCapabilityWarnings() {
  const caps = await getVectorCapabilities();
  for (const w of caps.warnings) {
    console.warn(`[vector-memory] ⚠️  ${w}`);
  }
  if (!caps.embeddings) {
    console.error(
      '[vector-memory] ✖  CRITICAL: Vector memory is DISABLED (no embeddings). ' +
      'storeMemory() and searchMemory() will THROW (code: EMBEDDINGS_UNAVAILABLE). ' +
      'Agents run without past-fix context until OPENAI_API_KEY is set. ' +
      'See README § "Vector Memory (Redis Stack + OpenAI)" for setup instructions.'
    );
  } else if (!caps.redisSearch) {
    console.warn(
      '[vector-memory] ⚠  PERFORMANCE WARNING: Redis Stack (RediSearch) is NOT available. ' +
      'Semantic search is running in HSCAN brute-force mode (O(n) full-scan cosine). ' +
      'This is acceptable up to ~10 k entries per tenant; beyond that it will become ' +
      'a bottleneck under concurrent load.\n' +
      '  ➜  Upgrade now:  docker run -p 6379:6379 redis/redis-stack-server:latest\n' +
      '  ➜  Current entry count can be checked with:  redis-cli ZCARD aegis:memory:age:<tenantId>'
    );
  }
  return caps;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export async function storeMemory(text, patch, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const vector = await embed(text);
  if (!vector) {
    // embed() returns null only when OPENAI_API_KEY is absent or the openai
    // package failed to load.  Silently dropping the write would mean the
    // memory system accepts calls but stores nothing, making RAG permanently
    // return empty results with no operator-visible signal.  Surface the
    // degraded state as a typed error so callers (and operators) can see it.
    const err = new Error(
      '[vector-memory] storeMemory: embeddings are unavailable ' +
      '(OPENAI_API_KEY not set or openai package missing). ' +
      'Memory was NOT stored. Set OPENAI_API_KEY to enable semantic memory.'
    );
    err.code = 'EMBEDDINGS_UNAVAILABLE';
    throw err;
  }

  const storedAt = Date.now();
  const id       = `${memoryPrefix(tenantId)}${storedAt}_${Math.random().toString(36).slice(2, 7)}`;

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

// ─── Shared reranking logic ───────────────────────────────────────────────────
// Used by both the FT.SEARCH path and the HSCAN fallback so BM25 + recency +
// adaptive-weight scoring is always applied regardless of Redis flavour.

async function _rerank(candidates, queryTerms, tenantId, topK) {
  if (!candidates.length) return [];

  const idfMap    = await computeIDF(tenantId, queryTerms);
  const statsKey  = bm25StatsKey(tenantId);
  const statsRaw  = await redis.hmget(statsKey, 'docCount', 'totalLen');
  const docCount  = parseFloat(statsRaw[0] ?? '1');
  const totalLen  = parseFloat(statsRaw[1] ?? '1');
  const avgdl     = totalLen / Math.max(docCount, 1);

  const withScores = candidates.map(item => {
    const docTF   = deserialiseTF(item.termFreq);
    const docLen  = parseInt(item.docLen ?? '0', 10);
    const cosine  = item.cosine;                           // pre-computed by caller
    const recency = recencyScore(parseInt(item.storedAt ?? '0', 10));
    const rawBM25 = bm25Score(docTF, docLen, avgdl, idfMap);
    return { item, cosine, recency, rawBM25 };
  });

  const maxBM25 = Math.max(...withScores.map(s => s.rawBM25), 1e-9);
  const w       = await loadWeights(tenantId);

  return withScores
    .map(({ item, cosine, recency, rawBM25 }) => {
      const bm25Normalised = rawBM25 / maxBM25;
      const qualityScore   = w.cosine  * cosine
                           + w.bm25    * bm25Normalised
                           + w.recency * recency;

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
        similarity:       cosine,
        cosine,
        bm25:             bm25Normalised,
        recency,
        qualityScore,
        leadingComponent,
      };
    })
    .filter(item => item.qualityScore >= MIN_QUALITY_SCORE)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, topK);
}

// ─── Search ───────────────────────────────────────────────────────────────────
//
// Two code paths, same output contract:
//
//   Redis Stack available → FT.SEARCH KNN over-fetch → shared _rerank()
//   Plain Redis           → HSCAN brute-force cosine → shared _rerank()
//
// BM25 + recency + adaptive weights are applied identically on both paths.
// The only difference is retrieval speed and ANN vs exact cosine.

export async function searchMemory(query, topK = 3, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const queryVec = await embed(query);
  if (!queryVec) {
    // Same reasoning as storeMemory: returning [] silently makes RAG look
    // "working but empty" to every upstream caller.  A typed error lets
    // callers decide whether to degrade gracefully or surface the problem.
    const err = new Error(
      '[vector-memory] searchMemory: embeddings are unavailable ' +
      '(OPENAI_API_KEY not set or openai package missing). ' +
      'Set OPENAI_API_KEY to enable semantic memory search.'
    );
    err.code = 'EMBEDDINGS_UNAVAILABLE';
    throw err;
  }

  const queryTerms = tokenise(query);
  const hasSearch  = await _probeRedisSearch();

  if (hasSearch) {
    // ── Redis Stack path: KNN over-fetch via FT.SEARCH ──────────────────────
    const idx        = indexName(tenantId);
    const fetchCount = topK * OVERFETCH_FACTOR;

    let res;
    try {
      res = await redis.call(
        'FT.SEARCH', idx,
        `*=>[KNN ${fetchCount} @vector $vec AS __dist]`,
        'PARAMS', '2', 'vec',
        Buffer.from(new Float32Array(queryVec).buffer),
        'SORTBY', '__dist',
        'RETURN', '7', 'text', 'patch', 'storedAt', '__dist', 'termFreq', 'docLen', 'score',
        'DIALECT', '2'
      );
    } catch (err) {
      // FT.SEARCH failed at runtime (e.g. index not yet created for this tenant,
      // or Redis Stack was removed from the server).  Flip the cached flag and
      // fall through to the HSCAN path so the call still returns useful results.
      const isUnknown =
        err.message?.includes('ERR unknown command') ||
        err.message?.includes('unknown command');
      if (isUnknown) {
        _redisSearchAvailable = false;
        console.warn('[vector-memory] FT.SEARCH failed — switching to HSCAN fallback:', err.message);
      } else {
        // Non-capability error (e.g. index missing, malformed query) — surface it.
        console.warn('[vector-memory] FT.SEARCH error:', err.message);
        return [];
      }

      // Fall through to HSCAN below
      const fallbackCandidates = await _hscanSearch(tenantId, queryVec, topK);
      return _rerank(fallbackCandidates, queryTerms, tenantId, topK);
    }

    // Parse the flat FT.SEARCH response: [count, key1, [field, val, ...], key2, ...]
    const candidates = [];
    for (let i = 1; i < res.length; i += 2) {
      const fields = res[i + 1];
      const item   = {};
      for (let j = 0; j < fields.length; j += 2) item[fields[j]] = fields[j + 1];
      const distance = parseFloat(item.__dist ?? '1');
      item.cosine    = Math.max(0, 1 - distance); // convert L2 distance to cosine similarity
      candidates.push(item);
    }

    return _rerank(candidates, queryTerms, tenantId, topK);
  }

  // ── HSCAN fallback path: brute-force cosine on plain Redis ─────────────────
  const candidates = await _hscanSearch(tenantId, queryVec, topK * OVERFETCH_FACTOR);
  return _rerank(candidates, queryTerms, tenantId, topK);
}
