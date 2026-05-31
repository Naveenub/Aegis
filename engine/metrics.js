/**
 * engine/metrics.js — time-series metrics store, Redis-backed
 *
 * What changed and why
 * ─────────────────────
 * The previous implementation stored all-time HINCRBY counters and a flat
 * RPUSH latency list.  That gives you totals but no trends: you can't answer
 * "what was the error rate in the last 5 minutes?" or "is p99 latency rising?"
 * without reading the entire list and aggregating in memory.
 *
 * This version adds:
 *   1. Windowed rollup buckets — each observation is written into a 1-minute
 *      Redis sorted-set bucket as well as the all-time counters.  Buckets
 *      older than BUCKET_RETENTION_S are expired automatically by Redis TTL.
 *   2. Percentile computation — p50/p95/p99 derived from bucketed latency
 *      samples within any requested time window, not the full history.
 *   3. Prometheus text-format export — GET /metrics (scraped by Prometheus,
 *      Grafana Agent, etc.)
 *   4. OTEL-compatible JSON export — GET /metrics/json (OpenTelemetry
 *      Collector HTTP receiver, dashboards, custom tooling).
 *
 * Redis key layout (additions over previous version)
 * ───────────────────────────────────────────────────
 *   aegis:metrics:counters               HASH  — all-time totals (unchanged)
 *   aegis:metrics:latency                LIST  — all-time latency samples (unchanged)
 *   aegis:metrics:agent:{name}           HASH  — all-time per-agent totals (unchanged)
 *   aegis:metrics:step:{stepId}          HASH  — per-step span (unchanged)
 *   aegis:metrics:steps:completed        ZSET  — step completion index (unchanged)
 *   aegis:metrics:start:{jobId}          STRING — startMs with TTL (unchanged)
 *
 *   [NEW] aegis:metrics:win:{window}:{bucketMin}
 *     HASH — counters for this 1-minute bucket in this named window
 *     Fields: total, success, failed, retries
 *     TTL:   set to BUCKET_RETENTION_S at write time
 *
 *   [NEW] aegis:metrics:lat:{window}:{bucketMin}
 *     ZSET — latency samples (score = latency ms, member = jobId:timestamp)
 *     TTL:  BUCKET_RETENTION_S
 *
 * Windows
 * ────────
 *   '1m'  → last  1 minute  (buckets: last  1 bucket)
 *   '5m'  → last  5 minutes (buckets: last  5 buckets)
 *   '1h'  → last 60 minutes (buckets: last 60 buckets)
 *
 * Bucket granularity: 1 minute (floor(now / 60000) * 60000)
 */

import IORedis from 'ioredis';

const redis = new IORedis();

// ─── Configuration ────────────────────────────────────────────────────────────

/** How many 1-minute buckets to retain. 2 h of history = 120 buckets. */
const BUCKET_RETENTION_S = 2 * 60 * 60; // 2 hours

/** Named windows: label → number of 1-minute buckets to look back */
const WINDOWS = { '1m': 1, '5m': 5, '1h': 60 };

const START_TTL_S = 3600;

// ─── Key helpers ──────────────────────────────────────────────────────────────

const K = {
  counters:         'aegis:metrics:counters',
  latency:          'aegis:metrics:latency',
  agent:   name  => `aegis:metrics:agent:${name}`,
  step:    id    => `aegis:metrics:step:${id}`,
  steps:            'aegis:metrics:steps:completed',
  start:   jobId => `aegis:metrics:start:${jobId}`,
  // windowed buckets
  win:  (window, bucketMin) => `aegis:metrics:win:${window}:${bucketMin}`,
  lat:  (window, bucketMin) => `aegis:metrics:lat:${window}:${bucketMin}`,
};

// ─── Bucket helpers ───────────────────────────────────────────────────────────

/** Floor timestamp to the current 1-minute bucket (epoch minutes). */
function currentBucket(nowMs = Date.now()) {
  return Math.floor(nowMs / 60_000) * 60_000;
}

/** Return the N most-recent bucket timestamps (including current). */
function recentBuckets(n, nowMs = Date.now()) {
  const base = currentBucket(nowMs);
  return Array.from({ length: n }, (_, i) => base - i * 60_000);
}

// ─── Windowed write helpers ───────────────────────────────────────────────────

/**
 * Increment a counter field in every window's current bucket.
 * Each bucket key gets a TTL of BUCKET_RETENTION_S so Redis auto-expires old data.
 *
 * @param {string} field   - 'total' | 'success' | 'failed' | 'retries'
 * @param {number} [by=1]
 */
async function incWindowCounter(field, by = 1) {
  const bucket = currentBucket();
  const pipeline = redis.pipeline();
  for (const window of Object.keys(WINDOWS)) {
    const key = K.win(window, bucket);
    pipeline.hincrby(key, field, by);
    pipeline.expire(key, BUCKET_RETENTION_S);
  }
  await pipeline.exec();
}

/**
 * Record a latency sample into every window's current bucket sorted set.
 * Member is unique (jobId + timestamp) so concurrent writes never collide.
 *
 * @param {string} jobId
 * @param {number} latencyMs
 */
async function recordLatencySample(jobId, latencyMs) {
  const bucket = currentBucket();
  const member = `${jobId}:${Date.now()}`;
  const pipeline = redis.pipeline();
  for (const window of Object.keys(WINDOWS)) {
    const key = K.lat(window, bucket);
    pipeline.zadd(key, latencyMs, member);   // score = latency ms
    pipeline.expire(key, BUCKET_RETENTION_S);
  }
  // All-time list kept for backward compat
  pipeline.rpush(K.latency, latencyMs.toString());
  await pipeline.exec();
}

// ─── Percentile computation ───────────────────────────────────────────────────

/**
 * Compute p50/p95/p99 latency from the bucketed sorted sets for a given window.
 * ZRANGE with BYSCORE gives us all members sorted by latency (score), so
 * percentile = element at index floor(count * p / 100).
 *
 * We fetch all samples across all buckets in the window, collect their scores
 * (latency values), sort, then index.
 *
 * @param {string} window  - '1m' | '5m' | '1h'
 * @returns {Promise<{ p50: number, p95: number, p99: number, count: number }>}
 */
async function computePercentiles(window) {
  const n = WINDOWS[window] ?? 5;
  const buckets = recentBuckets(n);

  // Fetch all latency members+scores from all buckets in one pipeline
  const pipeline = redis.pipeline();
  for (const bucket of buckets) {
    pipeline.zrange(K.lat(window, bucket), 0, -1, 'WITHSCORES');
  }
  const results = await pipeline.exec();

  // Collect all latency values (scores)
  const latencies = [];
  for (const [err, members] of results) {
    if (err || !Array.isArray(members)) continue;
    // zrange WITHSCORES returns [member, score, member, score, ...]
    for (let i = 1; i < members.length; i += 2) {
      latencies.push(Number(members[i]));
    }
  }

  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };

  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.floor((latencies.length - 1) * p / 100)] ?? 0;

  return {
    p50:   Math.round(pct(50)),
    p95:   Math.round(pct(95)),
    p99:   Math.round(pct(99)),
    count: latencies.length,
  };
}

// ─── Windowed counter rollup ──────────────────────────────────────────────────

/**
 * Sum counter fields across all buckets in a window.
 *
 * @param {string} window
 * @returns {Promise<{ total, success, failed, retries }>}
 */
async function windowCounters(window) {
  const n = WINDOWS[window] ?? 5;
  const buckets = recentBuckets(n);

  const pipeline = redis.pipeline();
  for (const bucket of buckets) pipeline.hgetall(K.win(window, bucket));
  const results = await pipeline.exec();

  let total = 0, success = 0, failed = 0, retries = 0;
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    total   += Number(raw.total   ?? 0);
    success += Number(raw.success ?? 0);
    failed  += Number(raw.failed  ?? 0);
    retries += Number(raw.retries ?? 0);
  }
  return { total, success, failed, retries };
}

// ─── Public write API (same signatures as before) ────────────────────────────

export async function recordStart(jobId) {
  await Promise.all([
    redis.hincrby(K.counters, 'total', 1),
    redis.set(K.start(jobId), Date.now().toString(), 'EX', START_TTL_S),
    incWindowCounter('total'),
  ]);
}

export async function recordRetry() {
  await Promise.all([
    redis.hincrby(K.counters, 'retries', 1),
    incWindowCounter('retries'),
  ]);
}

export async function recordSuccess(jobId) {
  const startRaw = await redis.get(K.start(jobId));
  const pipeline = redis.pipeline();

  pipeline.hincrby(K.counters, 'success', 1);

  if (startRaw) {
    const latency = Date.now() - Number(startRaw);
    pipeline.del(K.start(jobId));
    await pipeline.exec();
    await Promise.all([
      recordLatencySample(jobId, latency),
      incWindowCounter('success'),
    ]);
  } else {
    await pipeline.exec();
    await incWindowCounter('success');
  }
}

export async function recordFailure(jobId) {
  const startRaw = await redis.get(K.start(jobId));
  const pipeline = redis.pipeline();

  pipeline.hincrby(K.counters, 'failed', 1);

  if (startRaw) {
    const latency = Date.now() - Number(startRaw);
    pipeline.del(K.start(jobId));
    await pipeline.exec();
    await Promise.all([
      recordLatencySample(jobId, latency),
      incWindowCounter('failed'),
    ]);
  } else {
    await pipeline.exec();
    await incWindowCounter('failed');
  }
}

export async function recordStepStart(stepId, agentName) {
  await redis.hset(K.step(stepId), {
    agentName,
    startMs: Date.now().toString(),
    status:  'running',
  });
}

export async function recordStepEnd(stepId, status) {
  const raw = await redis.hgetall(K.step(stepId));
  if (!raw?.startMs) return;

  const endMs      = Date.now();
  const durationMs = endMs - Number(raw.startMs);
  const agent      = raw.agentName || 'unknown';

  const pipeline = redis.pipeline();
  pipeline.hset(K.step(stepId), { endMs: endMs.toString(), durationMs: durationMs.toString(), status });
  pipeline.zadd(K.steps, endMs, stepId);
  pipeline.hincrby(K.agent(agent), 'count',   1);
  pipeline.hincrby(K.agent(agent), 'totalMs', durationMs);
  await pipeline.exec();
}

// ─── Public read API ──────────────────────────────────────────────────────────

/**
 * getMetrics()
 *
 * Returns all-time counters + per-window rollups + percentiles.
 * Backward-compatible: the top-level shape is a superset of the old response.
 */
export async function getMetrics() {
  const [countersRaw, latencyRaw, stepIds] = await Promise.all([
    redis.hgetall(K.counters),
    redis.lrange(K.latency, 0, -1),
    redis.zrevrange(K.steps, 0, 49),
  ]);

  const total   = Number(countersRaw?.total   ?? 0);
  const success = Number(countersRaw?.success ?? 0);
  const failed  = Number(countersRaw?.failed  ?? 0);
  const retries = Number(countersRaw?.retries ?? 0);

  const latencies  = (latencyRaw ?? []).map(Number);
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  const agentKeys = await redis.keys('aegis:metrics:agent:*');
  const [agentRaws, stepRaws] = await Promise.all([
    agentKeys.length
      ? Promise.all(agentKeys.map(k => redis.hgetall(k).then(h => ({ k, h }))))
      : Promise.resolve([]),
    stepIds.length
      ? Promise.all(stepIds.map(id => redis.hgetall(K.step(id)).then(h => ({ id, h }))))
      : Promise.resolve([]),
  ]);

  const byAgent = {};
  for (const { k, h } of agentRaws) {
    const name  = k.replace('aegis:metrics:agent:', '');
    const count = Number(h?.count   ?? 0);
    const tot   = Number(h?.totalMs ?? 0);
    byAgent[name] = { count, avgMs: count > 0 ? Math.round(tot / count) : 0 };
  }

  const recentSteps = stepRaws
    .filter(({ h }) => h?.status && h.status !== 'running')
    .map(({ id, h }) => ({
      stepId:     id,
      agent:      h.agentName,
      durationMs: Number(h.durationMs ?? 0),
      status:     h.status,
    }));

  // Windowed rollups + percentiles (all windows in parallel)
  const windowNames = Object.keys(WINDOWS);
  const [windowResults, percentileResults] = await Promise.all([
    Promise.all(windowNames.map(w => windowCounters(w).then(c => ({ w, c })))),
    Promise.all(windowNames.map(w => computePercentiles(w).then(p => ({ w, p })))),
  ]);

  const windows = {};
  for (const { w, c } of windowResults) {
    const pctEntry = percentileResults.find(r => r.w === w)?.p ?? {};
    windows[w] = {
      ...c,
      successRate: c.total > 0 ? +((c.success / c.total) * 100).toFixed(1) : 0,
      latency: pctEntry,
    };
  }

  return {
    // All-time (backward compat)
    total,
    success,
    failed,
    retries,
    successRate: total > 0 ? +((success / total) * 100).toFixed(1) : 0,
    avgLatency,
    byAgent,
    recentSteps,
    // Time-series windows (new)
    windows,
  };
}

// ─── Prometheus text-format export ───────────────────────────────────────────

/**
 * Render all metrics as Prometheus text format (exposition format 0.0.4).
 * Intended for GET /metrics — scraped by Prometheus, Grafana Agent, VictoriaMetrics, etc.
 *
 * @returns {Promise<string>}
 */
export async function renderPrometheus() {
  const m = await getMetrics();
  const lines = [];

  const g = (name, help, type, value, labels = '') => {
    lines.push(`# HELP aegis_${name} ${help}`);
    lines.push(`# TYPE aegis_${name} ${type}`);
    lines.push(`aegis_${name}${labels ? `{${labels}}` : ''} ${value}`);
  };

  // All-time counters
  g('jobs_total',   'Total jobs submitted',    'counter', m.total);
  g('jobs_success', 'Total jobs succeeded',    'counter', m.success);
  g('jobs_failed',  'Total jobs failed',       'counter', m.failed);
  g('jobs_retries', 'Total retry attempts',    'counter', m.retries);
  g('success_rate', 'All-time success rate %', 'gauge',   m.successRate);
  g('avg_latency_ms', 'All-time average latency ms', 'gauge', m.avgLatency);

  // Per-agent gauges
  lines.push('# HELP aegis_agent_jobs_total Jobs completed by agent');
  lines.push('# TYPE aegis_agent_jobs_total gauge');
  for (const [agent, stats] of Object.entries(m.byAgent)) {
    lines.push(`aegis_agent_jobs_total{agent="${agent}"} ${stats.count}`);
  }
  lines.push('# HELP aegis_agent_avg_latency_ms Average latency ms by agent');
  lines.push('# TYPE aegis_agent_avg_latency_ms gauge');
  for (const [agent, stats] of Object.entries(m.byAgent)) {
    lines.push(`aegis_agent_avg_latency_ms{agent="${agent}"} ${stats.avgMs}`);
  }

  // Windowed counters
  lines.push('# HELP aegis_window_jobs_total Jobs in time window');
  lines.push('# TYPE aegis_window_jobs_total gauge');
  for (const [win, data] of Object.entries(m.windows)) {
    lines.push(`aegis_window_jobs_total{window="${win}"} ${data.total}`);
  }

  lines.push('# HELP aegis_window_success_rate Success rate % in time window');
  lines.push('# TYPE aegis_window_success_rate gauge');
  for (const [win, data] of Object.entries(m.windows)) {
    lines.push(`aegis_window_success_rate{window="${win}"} ${data.successRate}`);
  }

  // Windowed latency percentiles
  for (const pct of ['p50', 'p95', 'p99']) {
    lines.push(`# HELP aegis_latency_${pct}_ms Latency ${pct} in time window (ms)`);
    lines.push(`# TYPE aegis_latency_${pct}_ms gauge`);
    for (const [win, data] of Object.entries(m.windows)) {
      lines.push(`aegis_latency_${pct}_ms{window="${win}"} ${data.latency[pct] ?? 0}`);
    }
  }

  lines.push('');  // trailing newline required by Prometheus spec
  return lines.join('\n');
}

// ─── OTEL-compatible JSON export ─────────────────────────────────────────────

/**
 * Render metrics as an OpenTelemetry-compatible JSON structure.
 * Follows the OTLP/JSON shape so it can be forwarded to an OTEL Collector
 * HTTP receiver or consumed directly by dashboards / alerting tools.
 *
 * @returns {Promise<object>}
 */
export async function renderOtel() {
  const m   = await getMetrics();
  const now = Date.now();

  const makeGauge = (name, description, value, attrs = {}) => ({
    name,
    description,
    unit: '',
    gauge: {
      dataPoints: [{
        attributes: Object.entries(attrs).map(([k, v]) => ({ key: k, value: { stringValue: String(v) } })),
        timeUnixNano: String(now * 1_000_000),
        asDouble: value,
      }],
    },
  });

  const metrics = [
    makeGauge('aegis.jobs.total',      'Total jobs submitted',     m.total),
    makeGauge('aegis.jobs.success',    'Total jobs succeeded',     m.success),
    makeGauge('aegis.jobs.failed',     'Total jobs failed',        m.failed),
    makeGauge('aegis.jobs.retries',    'Total retry attempts',     m.retries),
    makeGauge('aegis.success_rate',    'All-time success rate %',  m.successRate),
    makeGauge('aegis.avg_latency_ms',  'All-time avg latency ms',  m.avgLatency),
  ];

  // Per-agent
  for (const [agent, stats] of Object.entries(m.byAgent)) {
    metrics.push(makeGauge('aegis.agent.jobs',       'Jobs by agent',          stats.count,  { agent }));
    metrics.push(makeGauge('aegis.agent.avg_latency_ms', 'Avg latency by agent', stats.avgMs, { agent }));
  }

  // Windowed
  for (const [win, data] of Object.entries(m.windows)) {
    metrics.push(makeGauge('aegis.window.total',        'Window job count',      data.total,       { window: win }));
    metrics.push(makeGauge('aegis.window.success',      'Window success count',  data.success,     { window: win }));
    metrics.push(makeGauge('aegis.window.failed',       'Window failed count',   data.failed,      { window: win }));
    metrics.push(makeGauge('aegis.window.success_rate', 'Window success rate %', data.successRate, { window: win }));
    metrics.push(makeGauge('aegis.latency.p50_ms',      'Latency p50 ms',        data.latency.p50 ?? 0, { window: win }));
    metrics.push(makeGauge('aegis.latency.p95_ms',      'Latency p95 ms',        data.latency.p95 ?? 0, { window: win }));
    metrics.push(makeGauge('aegis.latency.p99_ms',      'Latency p99 ms',        data.latency.p99 ?? 0, { window: win }));
  }

  return {
    resourceMetrics: [{
      resource: {
        attributes: [
          { key: 'service.name',    value: { stringValue: 'aegis' } },
          { key: 'service.version', value: { stringValue: '1.0.0' } },
        ],
      },
      scopeMetrics: [{
        scope: { name: 'aegis.metrics', version: '1.0.0' },
        metrics,
      }],
    }],
  };
}
