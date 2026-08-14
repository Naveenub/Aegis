/**
 * engine/tenant-quota.js
 *
 * Tenant quota enforcement — the missing layer between "tenantId is stored in
 * Redis" and "nothing actually stops a tenant from consuming unbounded resources."
 *
 * Problems solved
 * ───────────────
 * 1. No resource cap: a single tenant could submit unlimited workflows / jobs
 *    and starve all other tenants.
 * 2. No billing hooks: there was nowhere to plug in usage tracking.
 * 3. No runtime enforcement: quota was not checked before work was accepted.
 *
 * Design
 * ──────
 * Quotas are stored per-tenant in Redis alongside the tenant metadata:
 *   aegis:tenant:quota:{tenantId}  – Hash of limit + usage counters
 *
 * Enforced at task-submission time (before the orchestrator runs):
 *   - maxActiveWorkflows  – concurrent workflows in running|paused state
 *   - maxDailyWorkflows   – workflows started in the current UTC day
 *   - maxQueuedJobs       – total jobs in queued/running state
 *
 * Usage counters are maintained by:
 *   - trackWorkflowStart()  – called by orchestrator.js
 *   - trackWorkflowEnd()    – called by workflow-store.js on terminal transitions
 *   - trackJobQueued()      – called by job-store.js on createJob()
 *   - trackJobDone()        – called by job-store.js on terminal job update
 *
 * Billing hooks
 * ─────────────
 * usageSummary(tenantId) returns structured usage data suitable for posting to
 * any billing backend.  Wire it into a periodic flush in your billing worker or
 * call it synchronously in a webhook handler.
 *
 * Default limits (all overrideable per tenant via setQuota())
 * ────────────────────────────────────────────────────────────
 *   maxActiveWorkflows:  10
 *   maxDailyWorkflows:   100
 *   maxQueuedJobs:       200
 */

import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined);

// ─── Key helpers ──────────────────────────────────────────────────────────────

const QUOTA_KEY   = (tenantId) => `aegis:tenant:quota:${tenantId}`;
const USAGE_KEY   = (tenantId) => `aegis:tenant:usage:${tenantId}`;
// Daily counter resets at UTC midnight; include the date so old keys expire naturally.
const dailyKey    = (tenantId) => {
  const d = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `aegis:tenant:daily:${tenantId}:${d}`;
};

// ─── Default limits ───────────────────────────────────────────────────────────

const DEFAULTS = {
  maxActiveWorkflows: 10,
  maxDailyWorkflows:  100,
  maxQueuedJobs:      200,
};

// ─── Quota CRUD ───────────────────────────────────────────────────────────────

/**
 * Set quota limits for a tenant.  Partial updates are merged — only the fields
 * you pass are changed; omitted fields keep their current or default values.
 *
 * @param {string} tenantId
 * @param {object} limits  – subset of { maxActiveWorkflows, maxDailyWorkflows, maxQueuedJobs }
 */
export async function setQuota(tenantId, limits = {}) {
  assertTenantId(tenantId);
  const fields = {};
  for (const [k, v] of Object.entries(limits)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      fields[k] = String(v);
    }
  }
  if (Object.keys(fields).length === 0) return;
  await redis.hset(QUOTA_KEY(tenantId), fields);
}

/**
 * Read the effective quota limits for a tenant.
 * Unset fields fall back to DEFAULTS.
 *
 * @param {string} tenantId
 * @returns {Promise<{ maxActiveWorkflows: number, maxDailyWorkflows: number, maxQueuedJobs: number }>}
 */
export async function getQuota(tenantId) {
  assertTenantId(tenantId);
  const raw = await redis.hgetall(QUOTA_KEY(tenantId));
  return {
    maxActiveWorkflows: raw?.maxActiveWorkflows != null
      ? parseInt(raw.maxActiveWorkflows, 10) : DEFAULTS.maxActiveWorkflows,
    maxDailyWorkflows:  raw?.maxDailyWorkflows  != null
      ? parseInt(raw.maxDailyWorkflows,  10) : DEFAULTS.maxDailyWorkflows,
    maxQueuedJobs:      raw?.maxQueuedJobs      != null
      ? parseInt(raw.maxQueuedJobs,      10) : DEFAULTS.maxQueuedJobs,
  };
}

// ─── Enforcement ──────────────────────────────────────────────────────────────

/**
 * Assert that the tenant may start a new workflow.
 * Throws a QuotaExceededError if any limit is breached.
 *
 * Call this inside orchestrator.js BEFORE createWorkflow().
 *
 * @param {string} tenantId
 * @throws {QuotaExceededError}
 */
export async function assertWorkflowQuota(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const [quota, activeRaw, dailyRaw] = await Promise.all([
    getQuota(tenantId),
    redis.hget(USAGE_KEY(tenantId), 'activeWorkflows'),
    redis.get(dailyKey(tenantId)),
  ]);

  const active = parseInt(activeRaw ?? '0', 10);
  const daily  = parseInt(dailyRaw  ?? '0', 10);

  if (active >= quota.maxActiveWorkflows) {
    throw new QuotaExceededError(
      `Tenant "${tenantId}" has reached the active workflow limit ` +
      `(${active}/${quota.maxActiveWorkflows}). ` +
      'Cancel or complete existing workflows before submitting new ones.',
      { dimension: 'activeWorkflows', current: active, limit: quota.maxActiveWorkflows }
    );
  }

  if (daily >= quota.maxDailyWorkflows) {
    throw new QuotaExceededError(
      `Tenant "${tenantId}" has reached the daily workflow limit ` +
      `(${daily}/${quota.maxDailyWorkflows}). ` +
      'Limit resets at UTC midnight.',
      { dimension: 'dailyWorkflows', current: daily, limit: quota.maxDailyWorkflows }
    );
  }
}

/**
 * Assert that the tenant may queue a new job.
 * Throws a QuotaExceededError if the queued-jobs limit is breached.
 *
 * Call this inside job-store.js BEFORE createJob().
 *
 * @param {string} tenantId
 * @throws {QuotaExceededError}
 */
export async function assertJobQuota(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const [quota, queuedRaw] = await Promise.all([
    getQuota(tenantId),
    redis.hget(USAGE_KEY(tenantId), 'queuedJobs'),
  ]);

  const queued = parseInt(queuedRaw ?? '0', 10);

  if (queued >= quota.maxQueuedJobs) {
    throw new QuotaExceededError(
      `Tenant "${tenantId}" has reached the queued jobs limit ` +
      `(${queued}/${quota.maxQueuedJobs}).`,
      { dimension: 'queuedJobs', current: queued, limit: quota.maxQueuedJobs }
    );
  }
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

/**
 * Record that a workflow was started.  Call from orchestrator.js after
 * createWorkflow() succeeds.
 *
 * @param {string} tenantId
 */
export async function trackWorkflowStart(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const pipeline = redis.pipeline();
  // Active counter (decremented on terminal transition)
  pipeline.hincrby(USAGE_KEY(tenantId), 'activeWorkflows', 1);
  pipeline.hincrby(USAGE_KEY(tenantId), 'totalWorkflows',  1);
  // Daily counter — TTL of 25 h so it survives a UTC midnight rollover with margin
  pipeline.incr(dailyKey(tenantId));
  pipeline.expire(dailyKey(tenantId), 90_000); // 25 h in seconds
  await pipeline.exec();
}

/**
 * Record that a workflow reached a terminal state (completed|cancelled|failed).
 * Decrements the active-workflow counter.
 *
 * @param {string} tenantId
 */
export async function trackWorkflowEnd(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  // HINCRBY with -1 floors at 0 via a Lua script to avoid going negative.
  await redis.eval(
    `local v = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
     if tonumber(v) < 0 then redis.call('HSET', KEYS[1], ARGV[1], 0) end
     return v`,
    1,
    USAGE_KEY(tenantId),
    'activeWorkflows'
  );
}

/**
 * Record that a job was queued.  Call from job-store.js in createJob().
 *
 * @param {string} tenantId
 */
export async function trackJobQueued(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const pipeline = redis.pipeline();
  pipeline.hincrby(USAGE_KEY(tenantId), 'queuedJobs',  1);
  pipeline.hincrby(USAGE_KEY(tenantId), 'totalJobs',   1);
  await pipeline.exec();
}

/**
 * Record that a job finished (completed|failed|skipped).
 * Decrements the queued-jobs counter.
 *
 * @param {string} tenantId
 */
export async function trackJobDone(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await redis.eval(
    `local v = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
     if tonumber(v) < 0 then redis.call('HSET', KEYS[1], ARGV[1], 0) end
     return v`,
    1,
    USAGE_KEY(tenantId),
    'queuedJobs'
  );
}

// ─── Billing hook ─────────────────────────────────────────────────────────────

/**
 * Return structured usage data for billing or observability.
 * Call from a periodic billing-flush worker, or expose via a management endpoint.
 *
 * Shape:
 * {
 *   tenantId:         string,
 *   snapshot:         { activeWorkflows, queuedJobs, totalWorkflows, totalJobs },
 *   daily:            { workflowsToday: number },
 *   quota:            { maxActiveWorkflows, maxDailyWorkflows, maxQueuedJobs },
 *   recordedAt:       number  (ms epoch)
 * }
 *
 * @param {string} tenantId
 * @returns {Promise<object>}
 */
export async function usageSummary(tenantId) {
  assertTenantId(tenantId);

  const [usageRaw, quota, workflowsToday] = await Promise.all([
    redis.hgetall(USAGE_KEY(tenantId)),
    getQuota(tenantId),
    redis.get(dailyKey(tenantId)),
  ]);

  const snapshot = {
    activeWorkflows: parseInt(usageRaw?.activeWorkflows ?? '0', 10),
    queuedJobs:      parseInt(usageRaw?.queuedJobs      ?? '0', 10),
    totalWorkflows:  parseInt(usageRaw?.totalWorkflows   ?? '0', 10),
    totalJobs:       parseInt(usageRaw?.totalJobs        ?? '0', 10),
  };

  return {
    tenantId,
    snapshot,
    daily:      { workflowsToday: parseInt(workflowsToday ?? '0', 10) },
    quota,
    recordedAt: Date.now(),
  };
}

// ─── Error class ──────────────────────────────────────────────────────────────

export class QuotaExceededError extends Error {
  /**
   * @param {string} message
   * @param {{ dimension: string, current: number, limit: number }} meta
   */
  constructor(message, meta = {}) {
    super(message);
    this.name    = 'QuotaExceededError';
    this.code    = 'QUOTA_EXCEEDED';
    this.meta    = meta;
  }
}
