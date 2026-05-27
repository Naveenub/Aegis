/**
 * metrics.js — job/step metric store
 *
 * FIX: The original code did an unguarded load→mutate→save on a flat JSON file.
 * Under concurrent BullMQ workers this is a classic read-modify-write race:
 * two workers read the same stale snapshot, both increment counters, and the
 * last writer silently drops the other worker's update.
 *
 * Solution: wrap every mutation in a retry loop using `proper-lockfile`, which
 * creates an advisory `.lock` file next to metrics.json. If another process
 * already holds the lock the call retries (up to LOCK_RETRIES times) so no
 * update is ever lost. Reads (getMetrics) intentionally skip the lock — they
 * only need an eventually-consistent snapshot for the dashboard.
 */

import fs   from 'fs';
import path from 'path';
import lock from 'proper-lockfile';

const PATH      = '.claude/context/metrics.json';
const LOCK_OPTS = {
  retries : { retries: 10, minTimeout: 50, maxTimeout: 200, factor: 1.5 },
  stale   : 15_000,   // treat a lock as stale after 15 s (crashed worker)
};

// ─── internal helpers ────────────────────────────────────────────────────────

function ensureFile() {
  if (!fs.existsSync(PATH)) {
    fs.mkdirSync(path.dirname(PATH), { recursive: true });
    fs.writeFileSync(PATH, JSON.stringify(empty(), null, 2));
  }
}

function empty() {
  return {
    total   : 0,
    success : 0,
    failed  : 0,
    retries : 0,
    latency : [],
    byAgent : {},   // { [agentName]: { count, totalMs } }
    byStep  : {},   // { [stepId]:  { agentName, startMs, endMs, durationMs, status } }
  };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(PATH, 'utf-8'));
  } catch {
    return empty();
  }
}

function save(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

/**
 * Acquire an exclusive advisory lock, run `fn(data)` which mutates the
 * in-memory object, then flush to disk and release.
 *
 * `fn` receives the current parsed metrics and must return the (mutated)
 * object to persist.  Any exception inside `fn` releases the lock before
 * propagating so the process never dead-locks itself.
 */
async function withLock(fn) {
  ensureFile();
  const release = await lock.lock(PATH, LOCK_OPTS);
  try {
    const data = load();
    const updated = fn(data);   // synchronous mutation
    save(updated);
  } finally {
    await release();
  }
}

// ─── job-level (workflow) ────────────────────────────────────────────────────

export async function recordStart(jobId) {
  await withLock(data => {
    data.total += 1;
    data[`start_${jobId}`] = Date.now();
    return data;
  });
}

export async function recordRetry() {
  await withLock(data => {
    data.retries += 1;
    return data;
  });
}

export async function recordSuccess(jobId) {
  await withLock(data => {
    data.success += 1;
    const start = data[`start_${jobId}`];
    if (start) {
      data.latency.push(Date.now() - start);
      delete data[`start_${jobId}`];
    }
    return data;
  });
}

export async function recordFailure(jobId) {
  await withLock(data => {
    data.failed += 1;
    const start = data[`start_${jobId}`];
    if (start) {
      data.latency.push(Date.now() - start);
      delete data[`start_${jobId}`];
    }
    return data;
  });
}

// ─── per-step spans ──────────────────────────────────────────────────────────

/**
 * Mark a step as started for a given agent.
 * @param {string} stepId
 * @param {string} agentName
 */
export async function recordStepStart(stepId, agentName) {
  await withLock(data => {
    data.byStep[stepId] = { agentName, startMs: Date.now(), status: 'running' };
    return data;
  });
}

/**
 * Mark a step as finished and roll its duration into per-agent totals.
 * @param {string} stepId
 * @param {'success'|'failure'} status
 */
export async function recordStepEnd(stepId, status) {
  await withLock(data => {
    const span = data.byStep[stepId];
    if (!span) return data;

    const endMs      = Date.now();
    const durationMs = endMs - span.startMs;

    data.byStep[stepId] = { ...span, endMs, durationMs, status };

    const agent = span.agentName || 'unknown';
    if (!data.byAgent[agent]) data.byAgent[agent] = { count: 0, totalMs: 0 };
    data.byAgent[agent].count   += 1;
    data.byAgent[agent].totalMs += durationMs;

    return data;
  });
}

// ─── read (lock-free — eventual consistency is fine for dashboards) ───────────

export function getMetrics() {
  ensureFile();
  const data = load();

  const latencies  = data.latency ?? [];
  const avgLatency =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

  const byAgent = {};
  for (const [agent, { count, totalMs }] of Object.entries(data.byAgent ?? {})) {
    byAgent[agent] = { count, avgMs: count > 0 ? Math.round(totalMs / count) : 0 };
  }

  const completedSteps = Object.entries(data.byStep ?? {})
    .filter(([, s]) => s.status !== 'running')
    .map(([stepId, s]) => ({
      stepId,
      agent      : s.agentName,
      durationMs : s.durationMs,
      status     : s.status,
    }));

  return {
    total       : data.total,
    success     : data.success,
    failed      : data.failed,
    retries     : data.retries,
    successRate : data.total > 0 ? +((data.success / data.total) * 100).toFixed(1) : 0,
    avgLatency  : Math.round(avgLatency),
    byAgent,
    recentSteps : completedSteps.slice(-50),
  };
}