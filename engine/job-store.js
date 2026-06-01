/**
 * job-store.js — per-tenant job state store, Redis-backed
 *
 * FIX: The previous implementation wrote job records to flat JSON files under
 * .claude/context/tenants/{tenantId}/jobs.json while workflow step state lived
 * in Redis (workflow-store.js). The two stores were never reconciled:
 *
 *   - The /jobs API endpoint read the JSON file directly, returning stale or
 *     missing records when workers hadn't flushed yet.
 *   - proper-lockfile advisory locking is process-local; it gives no protection
 *     across hosts in a horizontally-scaled deployment.
 *   - listJobs() read from a hard-coded path (.claude/context/jobs.json) that
 *     ignored tenantId entirely.
 *
 * Fix: store every job record as a Redis hash at:
 *
 *   aegis:job:{tenantId}:{jobId}          ← the job fields
 *   aegis:jobs:index:{tenantId}           ← sorted set (score = createdAt ms)
 *                                            for ordered listing
 *
 * This keeps job state co-located with workflow state (both in Redis), makes
 * every read/write consistent without advisory locking, and works correctly
 * across multiple worker hosts.
 *
 * API is backward-compatible: same function names and signatures, all now async.
 */

import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined);

// ─── Key helpers ──────────────────────────────────────────────────────────────

function jobKey(tenantId, jobId) {
  return `aegis:job:${tenantId}:${jobId}`;
}

function indexKey(tenantId) {
  return `aegis:jobs:index:${tenantId}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a new job record for a step that is about to be executed.
 *
 * @param {string} jobId      - BullMQ job id
 * @param {object} step       - step object from the planner (id, agent, description)
 * @param {string} tenantId
 */
export async function createJob(jobId, step, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  const createdAt = Date.now();
  const record = {
    jobId,
    stepId   : step.id,
    agent    : step.agent,
    status   : 'queued',
    result   : '',
    retries  : '0',
    tenantId,
    createdAt: createdAt.toString(),
    updatedAt: createdAt.toString(),
  };

  const pipeline = redis.pipeline();
  // Store as a flat hash — all values must be strings for hset
  pipeline.hset(jobKey(tenantId, jobId), record);
  // Track in a sorted set ordered by creation time for listJobs()
  pipeline.zadd(indexKey(tenantId), createdAt, jobId);
  await pipeline.exec();
}

/**
 * Update fields on an existing job record.
 *
 * @param {string} jobId
 * @param {object} updates  - partial fields to merge (status, result, etc.)
 * @param {string} tenantId
 */
export async function updateJob(jobId, updates, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);

  // Stringify all values — Redis hashes store strings only
  const fields = {};
  for (const [k, v] of Object.entries(updates)) {
    fields[k] = v == null ? '' : String(v);
  }
  fields.updatedAt = Date.now().toString();

  await redis.hset(jobKey(tenantId, jobId), fields);
}

/**
 * Atomically increment the retry counter for a job.
 *
 * @param {string} jobId
 * @param {string} tenantId
 */
export async function incrementRetries(jobId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await redis.hincrby(jobKey(tenantId, jobId), 'retries', 1);
  await redis.hset(jobKey(tenantId, jobId), 'updatedAt', Date.now().toString());
}

/**
 * Retrieve a single job record.
 *
 * @param {string} jobId
 * @param {string} tenantId
 * @returns {object|null}
 */
export async function getJob(jobId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const raw = await redis.hgetall(jobKey(tenantId, jobId));
  if (!raw || Object.keys(raw).length === 0) return null;
  return deserialise(raw);
}

/**
 * List all job records for a tenant, newest first.
 *
 * @param {string} tenantId
 * @param {object} opts
 * @param {number} [opts.limit=200]  - max records to return
 * @returns {Promise<object[]>}
 */
export async function listJobs(tenantId = DEFAULT_TENANT, { limit = 200 } = {}) {
  assertTenantId(tenantId);

  // zrevrange returns jobIds ordered newest → oldest
  const jobIds = await redis.zrevrange(indexKey(tenantId), 0, limit - 1);
  if (jobIds.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const id of jobIds) pipeline.hgetall(jobKey(tenantId, id));
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (err || !raw || Object.keys(raw).length === 0 ? null : deserialise(raw)))
    .filter(Boolean);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Convert Redis string fields back to typed values.
 */
function deserialise(raw) {
  return {
    ...raw,
    retries  : parseInt(raw.retries ?? '0', 10),
    createdAt: raw.createdAt ? new Date(parseInt(raw.createdAt, 10)).toISOString() : null,
    updatedAt: raw.updatedAt ? new Date(parseInt(raw.updatedAt, 10)).toISOString() : null,
  };
}
