import fs from 'fs';

const PATH = '.claude/context/metrics.json';

function load() {
  if (!fs.existsSync(PATH)) {
    return {
      total: 0,
      success: 0,
      failed: 0,
      retries: 0,
      latency: [],
      byAgent: {},   // { [agentName]: { count, totalMs } }
      byStep: {},    // { [stepId]:  { agentName, startMs, endMs, durationMs, status } }
    };
  }
  return JSON.parse(fs.readFileSync(PATH, 'utf-8'));
}

function save(data) {
  fs.writeFileSync(PATH, JSON.stringify(data, null, 2));
}

// ─── job-level (workflow) ────────────────────────────────────────────────────

export function recordStart(jobId) {
  const data = load();
  data.total += 1;
  data[`start_${jobId}`] = Date.now();
  save(data);
}

export function recordRetry() {
  const data = load();
  data.retries += 1;
  save(data);
}

export function recordSuccess(jobId) {
  const data = load();
  data.success += 1;
  const start = data[`start_${jobId}`];
  if (start) {
    data.latency.push(Date.now() - start);
    delete data[`start_${jobId}`];
  }
  save(data);
}

export function recordFailure(jobId) {
  const data = load();
  data.failed += 1;
  const start = data[`start_${jobId}`];
  if (start) {
    data.latency.push(Date.now() - start);
    delete data[`start_${jobId}`];
  }
  save(data);
}

// ─── per-step spans ──────────────────────────────────────────────────────────

/**
 * Mark a step as started for a given agent.
 * @param {string} stepId
 * @param {string} agentName
 */
export function recordStepStart(stepId, agentName) {
  const data = load();
  data.byStep[stepId] = { agentName, startMs: Date.now(), status: 'running' };
  save(data);
}

/**
 * Mark a step as finished and roll its duration into per-agent totals.
 * @param {string} stepId
 * @param {'success'|'failure'} status
 */
export function recordStepEnd(stepId, status) {
  const data = load();
  const span = data.byStep[stepId];
  if (!span) return;

  const endMs = Date.now();
  const durationMs = endMs - span.startMs;

  data.byStep[stepId] = { ...span, endMs, durationMs, status };

  // Roll up into per-agent bucket
  const agent = span.agentName || 'unknown';
  if (!data.byAgent[agent]) data.byAgent[agent] = { count: 0, totalMs: 0 };
  data.byAgent[agent].count += 1;
  data.byAgent[agent].totalMs += durationMs;

  save(data);
}

// ─── read ────────────────────────────────────────────────────────────────────

export function getMetrics() {
  const data = load();

  const latencies = data.latency ?? [];
  const avgLatency =
    latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

  // Per-agent summary
  const byAgent = {};
  for (const [agent, { count, totalMs }] of Object.entries(data.byAgent ?? {})) {
    byAgent[agent] = { count, avgMs: count > 0 ? Math.round(totalMs / count) : 0 };
  }

  // Per-step summary (only completed spans to keep payload small)
  const completedSteps = Object.entries(data.byStep ?? {})
    .filter(([, s]) => s.status !== 'running')
    .map(([stepId, s]) => ({
      stepId,
      agent: s.agentName,
      durationMs: s.durationMs,
      status: s.status,
    }));

  return {
    total: data.total,
    success: data.success,
    failed: data.failed,
    retries: data.retries,
    successRate: data.total > 0 ? +((data.success / data.total) * 100).toFixed(1) : 0,
    avgLatency: Math.round(avgLatency),
    byAgent,
    recentSteps: completedSteps.slice(-50), // last 50 steps
  };
}