/**
 * engine/retention.js — enforces per-tenant retention policy
 *
 * runRetentionSweep() is what `npm run retention:sweep` (scripts/retention-sweep.js,
 * run daily by the k8s CronJob / Render cron) calls. For each tenant it applies
 * the tenant's effective policy (engine/retention-policy.js):
 *
 *   jobs       job records older than jobsDays are deleted
 *   workflows  TERMINAL workflows (completed | failed | cancelled) older than
 *              workflowsDays are fully purged: steps, meta, traces, review
 *              records, rewind history. Running/paused workflows are never
 *              touched.
 *   memory     vector-memory entries older than memoryDays are evicted
 *
 * Zero-retention tenants additionally get every terminal workflow scrubbed of
 * content (backstop for the on-completion hook) and all vector memory purged.
 *
 * purgeTenantContent() is the deletion-request path (DPA §8): removes ALL
 * workflow/job/memory content for a tenant regardless of age or status.
 * It intentionally leaves the audit log (tamper-evident chain, metadata only),
 * billing records, API-key records and the tenant registry entry — those are
 * retained for security and legal reasons and removed when the account is
 * closed.
 *
 * Not covered here (documented in docs-site/docs/compliance.md): HNSW index
 * files on disk keep embedding vectors of evicted memories until the index is
 * rebuilt; git history in the customer's own repository; provider-side logs.
 */

import IORedis from 'ioredis';
import { listTenants } from './tenant-registry.js';
import { getEffectivePolicy, invalidatePolicy } from './retention-policy.js';
import { purgeWorkflow, scrubWorkflowContent } from './workflow-purge.js';
import { evictExpiredMemory } from './vector-memory.js';
import { DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

const DAY_MS = 24 * 60 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const JOB_INDEX = (t) => `aegis:jobs:index:${t}`;
const JOB_KEY = (t, id) => `aegis:job:${t}:${id}`;

async function* scanKeys(match) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 500);
    cursor = next;
    for (const k of keys) yield k;
  } while (cursor !== '0');
}

async function purgeJobs(tenantId, cutoffMs, dryRun) {
  const ids = await redis.zrangebyscore(JOB_INDEX(tenantId), '-inf', cutoffMs);
  if (!ids.length || dryRun) return ids.length;
  const p = redis.pipeline();
  for (const id of ids) p.del(JOB_KEY(tenantId, id));
  p.zrem(JOB_INDEX(tenantId), ...ids);
  await p.exec();
  return ids.length;
}

function terminalAt(meta) {
  return meta.completedAt ?? meta.failedAt ?? meta.cancelledAt ?? meta.createdAt ?? meta.startedAt ?? 0;
}

/**
 * @param {{ now?: number, dryRun?: boolean, tenantIds?: string[] }} [opts]
 * @returns {Promise<{ dryRun: boolean, tenants: Record<string, {jobs:number, workflowsPurged:number, workflowsScrubbed:number, memory:number}>, errors: {scope:string, error:string}[] }>}
 */
export async function runRetentionSweep({ now = Date.now(), dryRun = false, tenantIds } = {}) {
  const ids = tenantIds ?? await listTenants();
  const out = { dryRun, tenants: {}, errors: [] };
  const policies = new Map();

  for (const t of ids) {
    out.tenants[t] = { jobs: 0, workflowsPurged: 0, workflowsScrubbed: 0, memory: 0 };
    try {
      invalidatePolicy(t); // always sweep against fresh policy
      const pol = await getEffectivePolicy(t);
      policies.set(t, pol);
      out.tenants[t].jobs = await purgeJobs(t, now - pol.jobsDays * DAY_MS, dryRun);
      if (!dryRun) {
        out.tenants[t].memory = await evictExpiredMemory(t, pol.zeroRetention ? 0 : pol.memoryDays * DAY_MS);
      }
    } catch (err) {
      out.errors.push({ scope: `tenant:${t}`, error: err.message });
    }
  }

  // One pass over all workflow metas, grouped by owning tenant.
  try {
    for await (const metaKey of scanKeys('aegis:workflow:meta:*')) {
      const workflowId = metaKey.slice('aegis:workflow:meta:'.length);
      try {
        const raw = await redis.get(metaKey);
        if (!raw) continue;
        const meta = JSON.parse(raw);
        const tenant = meta.tenantId ?? DEFAULT_TENANT;
        const pol = policies.get(tenant);
        if (!pol || !TERMINAL.has(meta.status)) continue;

        const age = now - terminalAt(meta);
        if (age >= pol.workflowsDays * DAY_MS) {
          if (!dryRun) await purgeWorkflow(workflowId);
          out.tenants[tenant].workflowsPurged++;
        } else if (pol.zeroRetention) {
          if (!dryRun) await scrubWorkflowContent(workflowId);
          out.tenants[tenant].workflowsScrubbed++;
        }
      } catch (err) {
        out.errors.push({ scope: `workflow:${workflowId}`, error: err.message });
      }
    }
  } catch (err) {
    out.errors.push({ scope: 'workflow-scan', error: err.message });
  }

  return out;
}

/**
 * Delete ALL workflow, job and vector-memory content for one tenant.
 * @param {string} tenantId
 * @returns {Promise<{ workflows:number, skippedActive:number, jobs:number, memory:number }>}
 */
export async function purgeTenantContent(tenantId) {
  const res = { workflows: 0, skippedActive: 0, jobs: 0, memory: 0 };

  for await (const metaKey of scanKeys('aegis:workflow:meta:*')) {
    const raw = await redis.get(metaKey);
    if (!raw) continue;
    const meta = JSON.parse(raw);
    if ((meta.tenantId ?? DEFAULT_TENANT) !== tenantId) continue;
    // Never delete state out from under a running workflow — cancel it first.
    if (!TERMINAL.has(meta.status)) { res.skippedActive++; continue; }
    await purgeWorkflow(metaKey.slice('aegis:workflow:meta:'.length));
    res.workflows++;
  }

  res.jobs = await purgeJobs(tenantId, Number.MAX_SAFE_INTEGER, false);
  res.memory = await evictExpiredMemory(tenantId, 0);
  return res;
}
