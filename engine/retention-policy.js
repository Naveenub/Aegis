/**
 * engine/retention-policy.js — per-tenant data-retention policy + zero-retention flag
 *
 * Deliberately tiny and dependency-light: job-store, vector-memory, audit-log
 * and workflow-store all consult it on their write paths, so it must not pull
 * in anything that could create an import cycle. The sweeper that *enforces*
 * the policy lives in engine/retention.js.
 *
 * What is configurable (days, 1–365, per tenant; null = platform default)
 *   jobsDays       job records (status + metadata)             default 90
 *   workflowsDays  finished workflow records + traces + reviews default 90
 *   memoryDays     vector-memory entries (past tasks + patches) default AEGIS_MEMORY_TTL_DAYS (30)
 *
 * What is NOT configurable
 *   The compliance audit log. It is a tamper-evident hash chain, so pruning
 *   would break verifyChain(). It holds metadata only (actor, action, resource
 *   ids) — plus a 500-char task excerpt, which zero-retention mode replaces
 *   with a redaction marker.
 *
 * Zero-retention mode (tenant.zeroRetention = true)
 *   Aegis does not keep customer content after a workflow ends:
 *     • vector memory is neither written nor read (so nothing is sent to the
 *       embeddings provider either) and existing entries are purged;
 *     • job `result` text is redacted at write time;
 *     • the audit-log task excerpt is redacted at write time;
 *     • when a workflow reaches a terminal state, step descriptions, traces
 *       (patches / test output), review records and rewind history are scrubbed
 *       (workflow-purge.js). While a workflow is RUNNING its content is held
 *       in Redis because execution and retries need it.
 *   It does NOT change what the LLM provider retains — that is governed by
 *   Aegis's agreement with that provider (see compliance/subprocessors.json).
 */

import { getRetentionConfig } from './tenant-registry.js';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

export const RETENTION_BOUNDS = Object.freeze({ min: 1, max: 365 });
export const REDACTED = '[redacted: zero-retention]';

const CACHE_TTL_MS = 15_000;
const cache = new Map(); // tenantId -> { at, policy }

function envDays(name, fallback) {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(n) && n >= RETENTION_BOUNDS.min && n <= RETENTION_BOUNDS.max ? n : fallback;
}

/** Platform defaults (env-overridable). */
export function defaultRetention() {
  return {
    jobsDays:      envDays('AEGIS_RETENTION_JOBS_DAYS', 90),
    workflowsDays: envDays('AEGIS_RETENTION_WORKFLOWS_DAYS', 90),
    memoryDays:    envDays('AEGIS_MEMORY_TTL_DAYS', 30),
  };
}

/**
 * Effective policy for a tenant: overrides merged over platform defaults.
 * Cached ~15 s per process; the PUT route calls invalidatePolicy() for its own
 * process, other processes pick the change up when their cache expires.
 *
 * @returns {Promise<{ jobsDays:number, workflowsDays:number, memoryDays:number, zeroRetention:boolean, overrides:object }>}
 */
export async function getEffectivePolicy(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.policy;

  const overrides = await getRetentionConfig(tenantId);
  const d = defaultRetention();
  const policy = {
    jobsDays:      overrides.jobsDays      ?? d.jobsDays,
    workflowsDays: overrides.workflowsDays ?? d.workflowsDays,
    memoryDays:    overrides.memoryDays    ?? d.memoryDays,
    zeroRetention: overrides.zeroRetention,
    overrides,
  };
  cache.set(tenantId, { at: Date.now(), policy });
  return policy;
}

/**
 * Like getEffectivePolicy() but never throws: on a registry read error it
 * returns the platform defaults with zero-retention off. For write paths that
 * only need a TTL and must not fail because the policy could not be read.
 */
export async function getPolicyOrDefault(tenantId = DEFAULT_TENANT) {
  try {
    return await getEffectivePolicy(tenantId);
  } catch {
    return { ...defaultRetention(), zeroRetention: false, overrides: {} };
  }
}

/**
 * Hot-path check used by write paths. If the flag cannot be read (Redis
 * error) this returns false rather than throwing: the same Redis is needed to
 * persist anything, and the sweeper scrubs zero-retention tenants regardless,
 * so a missed read can leave content behind for at most one sweep interval.
 */
export async function isZeroRetention(tenantId = DEFAULT_TENANT) {
  try {
    return (await getEffectivePolicy(tenantId ?? DEFAULT_TENANT)).zeroRetention === true;
  } catch {
    return false;
  }
}

export function invalidatePolicy(tenantId) {
  if (tenantId) cache.delete(tenantId); else cache.clear();
}

/**
 * Validate a PUT /tenants/:id/retention body.
 * @returns {{ updates?: object, error?: string }}
 */
export function parseRetentionUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be a JSON object.' };
  const allowed = ['jobsDays', 'workflowsDays', 'memoryDays', 'zeroRetention'];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.` };

  const updates = {};
  for (const k of ['jobsDays', 'workflowsDays', 'memoryDays']) {
    if (!(k in body)) continue;
    const v = body[k];
    if (v === null) { updates[k] = null; continue; } // reset to platform default
    if (!Number.isInteger(v) || v < RETENTION_BOUNDS.min || v > RETENTION_BOUNDS.max) {
      return { error: `${k} must be an integer between ${RETENTION_BOUNDS.min} and ${RETENTION_BOUNDS.max}, or null to reset to the default.` };
    }
    updates[k] = v;
  }
  if ('zeroRetention' in body) {
    if (typeof body.zeroRetention !== 'boolean') return { error: 'zeroRetention must be a boolean.' };
    updates.zeroRetention = body.zeroRetention;
  }
  if (!Object.keys(updates).length) return { error: 'Nothing to update.' };
  return { updates };
}
