/**
 * tracer.js — lightweight structured trace store, Redis-backed
 *
 * FIX: The previous implementation persisted all trace/span data to
 * .claude/context/traces.json, with proper-lockfile for intra-process safety.
 * proper-lockfile locks are process-local: in a multi-process or multi-host
 * BullMQ deployment each worker maintains its own copy of the file.  Spans
 * written by worker A are invisible to worker B; the dashboard shows an
 * incomplete trace at best, a corrupt one at worst.
 *
 * Fix: migrate to Redis, which is already the shared store used by the rest
 * of the engine.  Each span is stored as its own Redis hash so concurrent
 * writers never race — there is no read-modify-write cycle.
 *
 * Key layout
 * ──────────
 *   aegis:trace:{traceId}:meta          STRING (JSON) — traceId
 *   aegis:trace:{traceId}:span:{spanId} HASH   — step, agent, patch,
 *                                                testResult, startMs, endMs,
 *                                                status
 *   aegis:traces:index                  ZSET   — traceId scored by first-
 *                                                span startMs (for listing)
 *
 * Trace model (unchanged from the file-based version)
 * ────────────────────────────────────────────────────
 *   trace (traceId = workflowId)
 *     └─ span  (spanId = stepId)
 *           step        string
 *           agent       string
 *           patch       string | null
 *           testResult  { success, output } | null
 *           startMs     number
 *           endMs       number | null
 *           status      'running' | 'success' | 'failure'
 */

import IORedis from 'ioredis';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
// Without a listener, ioredis logs an unhandled 'error' event for every
// connection failure. Rejections already surface per-command to callers,
// so this listener only silences that duplicate console noise.
redis.on('error', () => {});

// ─── Key helpers ──────────────────────────────────────────────────────────────

const K = {
  meta:  traceId           => `aegis:trace:${traceId}:meta`,
  span:  (traceId, spanId) => `aegis:trace:${traceId}:span:${spanId}`,
  spans: traceId           => `aegis:trace:${traceId}:spans`,  // ZSET of spanIds scored by startMs
  index:                      'aegis:traces:index',
};

// ─── write ────────────────────────────────────────────────────────────────────

/**
 * Open a new span for a step.
 * @param {string} traceId   - workflowId
 * @param {string} spanId    - stepId
 * @param {string} stepDesc  - human-readable step description
 * @param {string} agent     - agent name executing this step
 */
export async function startSpan(traceId, spanId, stepDesc, agent) {
  const startMs = Date.now();

  const pipeline = redis.pipeline();

  // Upsert trace meta (NX keeps the original creation time on the index)
  pipeline.setnx(K.meta(traceId), JSON.stringify({ traceId }));

  // Store span fields in a hash — each field write is independent, no race
  pipeline.hset(K.span(traceId, spanId), {
    spanId,
    step:       stepDesc,
    agent,
    patch:      '',           // empty string == null (Redis hashes are strings)
    testResult: '',
    startMs:    startMs.toString(),
    endMs:      '',
    status:     'running',
  });

  // Index spans within the trace (score = startMs for ordered retrieval)
  pipeline.zadd(K.spans(traceId), startMs, spanId);

  // Index traces globally (NX: only set score on first span so order = trace creation time)
  pipeline.zadd(K.index, 'NX', startMs, traceId);

  await pipeline.exec();
}

/**
 * Attach the generated patch to an open span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {string} patch
 */
export async function attachPatch(traceId, spanId, patch) {
  await redis.hset(K.span(traceId, spanId), 'patch', patch ?? '');
}

/**
 * Attach the test result to an open span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {{ success: boolean, output: string }} testResult
 */
export async function attachTestResult(traceId, spanId, testResult) {
  await redis.hset(
    K.span(traceId, spanId),
    'testResult',
    testResult ? JSON.stringify(testResult) : '',
  );
}

/**
 * Close a span.
 * @param {string} traceId
 * @param {string} spanId
 * @param {'success'|'failure'} status
 */
export async function endSpan(traceId, spanId, status) {
  await redis.hset(K.span(traceId, spanId), {
    endMs:  Date.now().toString(),
    status,
  });
}

// ─── read (eventually consistent — fine for the UI) ──────────────────────────

/**
 * Deserialize a raw Redis hash into a typed span object.
 */
function deserializeSpan(raw) {
  if (!raw?.spanId) return null;
  return {
    spanId:     raw.spanId,
    step:       raw.step,
    agent:      raw.agent,
    patch:      raw.patch      || null,
    testResult: raw.testResult ? JSON.parse(raw.testResult) : null,
    startMs:    Number(raw.startMs),
    endMs:      raw.endMs ? Number(raw.endMs) : null,
    status:     raw.status,
  };
}

/**
 * Return the full trace for a workflow.
 * @param {string} traceId
 * @returns {{ traceId, spans: object } | null}
 */
export async function getTrace(traceId) {
  const metaRaw = await redis.get(K.meta(traceId));
  if (!metaRaw) return null;

  // Fetch all span IDs for this trace, then fetch each span hash in one pipeline
  const spanIds = await redis.zrange(K.spans(traceId), 0, -1);
  if (!spanIds.length) return { traceId, spans: {} };

  const pipeline = redis.pipeline();
  for (const spanId of spanIds) pipeline.hgetall(K.span(traceId, spanId));
  const results = await pipeline.exec();

  const spans = {};
  for (let i = 0; i < spanIds.length; i++) {
    const [err, raw] = results[i];
    if (err || !raw) continue;
    const span = deserializeSpan(raw);
    if (span) spans[spanIds[i]] = span;
  }

  return { traceId, spans };
}

/**
 * Return all traces (newest first, capped at limit).
 * @param {number} limit
 * @returns {Promise<Array>}
 */
export async function listTraces(limit = 100) {
  // Index is scored by first-span startMs; ZREVRANGE gives newest first
  const traceIds = await redis.zrevrange(K.index, 0, limit - 1);
  if (!traceIds.length) return [];

  const traces = await Promise.all(traceIds.map(id => getTrace(id)));
  return traces.filter(Boolean);
}
