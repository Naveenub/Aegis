/**
 * metrics.js — job/step metric store, Redis-backed
 *
 * FIX: The previous implementation wrote counters and span data to
 * .claude/context/metrics.json, protected only by `proper-lockfile`.
 * proper-lockfile advisory locks are process-local: they give no protection
 * across multiple BullMQ worker processes or multiple hosts.  Each process
 * maintained its own copy of the file, so the dashboard always showed a
 * partial view — only the metrics accumulated by whichever process happened
 * to be read.
 *
 * Fix: migrate every counter and span to Redis, which is already the shared
 * store used by job-store.js, workflow-store.js, and queue.js.
 *
 * Key layout
 * ──────────
 *   aegis:metrics:counters          HASH  — total, success, failed, retries
 *   aegis:metrics:latency           LIST  — RPUSH per-job latency ms (integers)
 *   aegis:metrics:agent:{name}      HASH  — count, totalMs
 *   aegis:metrics:step:{stepId}     HASH  — agentName, startMs, endMs,
 *                                           durationMs, status
 *   aegis:metrics:steps:completed   ZSET  — stepId scored by endMs
 *                                           (for ordered recent-steps query)
 *   aegis:metrics:start:{jobId}     STRING — startMs, TTL 1 h
 *
 * All counters use HINCRBY so concurrent writers never race; there is no
 * read-modify-write cycle anywhere in this module.
 */

import IORedis from 'ioredis';

const redis = new IORedis();

// ─── Key helpers ──────────────────────────────────────────────────────────────

const K = {
  counters:       'aegis:metrics:counters',
  latency:        'aegis:metrics:latency',
  agent:  name => `aegis:metrics:agent:${name}`,
  step:   id   => `aegis:metrics:step:${id}`,
  steps:          'aegis:metrics:steps:completed',
  start:  jobId => `aegis:metrics:start:${jobId}`,
};

const START_TTL_S = 3600; // 1 hour — discard start times for long-running jobs

// ─── job-level (workflow) ─────────────────────────────────────────────────────

export async function recordStart(jobId) {
  await Promise.all([
    redis.hincrby(K.counters, 'total', 1),
    redis.set(K.start(jobId), Date.now().toString(), 'EX', START_TTL_S),
  ]);
}

export async function recordRetry() {
  await redis.hincrby(K.counters, 'retries', 1);
}

export async function recordSuccess(jobId) {
  const pipeline = redis.pipeline();
  pipeline.hincrby(K.counters, 'success', 1);

  const startRaw = await redis.get(K.start(jobId));
  if (startRaw) {
    const latency = Date.now() - Number(startRaw);
    pipeline.rpush(K.latency, latency.toString());
    pipeline.del(K.start(jobId));
  }

  await pipeline.exec();
}

export async function recordFailure(jobId) {
  const pipeline = redis.pipeline();
  pipeline.hincrby(K.counters, 'failed', 1);

  const startRaw = await redis.get(K.start(jobId));
  if (startRaw) {
    const latency = Date.now() - Number(startRaw);
    pipeline.rpush(K.latency, latency.toString());
    pipeline.del(K.start(jobId));
  }

  await pipeline.exec();
}

// ─── per-step spans ───────────────────────────────────────────────────────────

/**
 * Mark a step as started for a given agent.
 * @param {string} stepId
 * @param {string} agentName
 */
export async function recordStepStart(stepId, agentName) {
  await redis.hset(K.step(stepId), {
    agentName,
    startMs: Date.now().toString(),
    status:  'running',
  });
}

/**
 * Mark a step as finished and roll its duration into per-agent totals.
 * @param {string} stepId
 * @param {'success'|'failure'} status
 */
export async function recordStepEnd(stepId, status) {
  const raw = await redis.hgetall(K.step(stepId));
  if (!raw?.startMs) return;

  const endMs      = Date.now();
  const durationMs = endMs - Number(raw.startMs);
  const agent      = raw.agentName || 'unknown';

  const pipeline = redis.pipeline();

  // Update the span record
  pipeline.hset(K.step(stepId), {
    endMs:      endMs.toString(),
    durationMs: durationMs.toString(),
    status,
  });

  // Add to the completed sorted set so getMetrics can page by recency
  pipeline.zadd(K.steps, endMs, stepId);

  // Roll into per-agent totals (atomic HINCRBY — no race)
  pipeline.hincrby(K.agent(agent), 'count',   1);
  pipeline.hincrby(K.agent(agent), 'totalMs', durationMs);

  await pipeline.exec();
}

// ─── read (eventually consistent — fine for dashboards) ──────────────────────

export async function getMetrics() {
  // Fetch all data concurrently
  const [countersRaw, latencyRaw, stepIds] = await Promise.all([
    redis.hgetall(K.counters),
    redis.lrange(K.latency, 0, -1),
    redis.zrevrange(K.steps, 0, 49),   // 50 most-recent completed steps
  ]);

  const total   = Number(countersRaw?.total   ?? 0);
  const success = Number(countersRaw?.success ?? 0);
  const failed  = Number(countersRaw?.failed  ?? 0);
  const retries = Number(countersRaw?.retries ?? 0);

  const latencies  = (latencyRaw ?? []).map(Number);
  const avgLatency =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

  // Fetch per-agent hashes and per-step hashes in parallel
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
    const total = Number(h?.totalMs ?? 0);
    byAgent[name] = { count, avgMs: count > 0 ? Math.round(total / count) : 0 };
  }

  const recentSteps = stepRaws
    .filter(({ h }) => h?.status && h.status !== 'running')
    .map(({ id, h }) => ({
      stepId:     id,
      agent:      h.agentName,
      durationMs: Number(h.durationMs ?? 0),
      status:     h.status,
    }));

  return {
    total,
    success,
    failed,
    retries,
    successRate: total > 0 ? +((success / total) * 100).toFixed(1) : 0,
    avgLatency,
    byAgent,
    recentSteps,
  };
}
