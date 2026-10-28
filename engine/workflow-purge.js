/**
 * engine/workflow-purge.js — delete or scrub one workflow's stored content
 *
 * Two operations, both keyed by workflowId:
 *
 *   scrubWorkflowContent(id)  Zero-retention. Keeps ids, statuses and
 *                             timestamps (so status polling and billing
 *                             reconciliation still work) but removes anything
 *                             derived from the customer's task or code: step
 *                             descriptions/errors/patches, traces, review
 *                             records, rewind history, free-text reasons.
 *
 *   purgeWorkflow(id)         Retention expiry / tenant deletion. Removes every
 *                             Redis key the workflow owns.
 *
 * Kept free of other engine imports (only ioredis + retention-policy) so
 * workflow-store.js can call scrubIfZeroRetention() without an import cycle.
 */

import IORedis from 'ioredis';
import { isZeroRetention, REDACTED } from './retention-policy.js';
import { DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

// Key layout owned by workflow-store.js / tracer.js — keep in sync.
const K = {
  steps:       (id)      => `aegis:workflow:${id}`,
  meta:        (id)      => `aegis:workflow:meta:${id}`,
  traceMeta:   (id)      => `aegis:trace:${id}:meta`,
  traceSpans:  (id)      => `aegis:trace:${id}:spans`,
  traceSpan:   (id, sp)  => `aegis:trace:${id}:span:${sp}`,
  traceIndex:  'aegis:traces:index',
  review:      (id, st)  => `aegis:review:${id}:${st}`,
  reviewIndex: 'aegis:review:index',
  rewindIndex: (id)      => `aegis:rewind:index:${id}`,
};

/** Delete traces, review records and rewind history for a workflow. */
async function deleteSideRecords(workflowId, stepIds) {
  const spanIds = await redis.zrange(K.traceSpans(workflowId), 0, -1);
  const rewindKeys = await redis.zrange(K.rewindIndex(workflowId), 0, -1);
  const reviewKeys = stepIds.map((s) => K.review(workflowId, s));

  const p = redis.pipeline();
  for (const sp of spanIds) p.del(K.traceSpan(workflowId, sp));
  p.del(K.traceSpans(workflowId), K.traceMeta(workflowId));
  p.zrem(K.traceIndex, workflowId);
  for (const k of rewindKeys) p.del(k);
  p.del(K.rewindIndex(workflowId));
  for (const k of reviewKeys) { p.del(k); p.zrem(K.reviewIndex, k); }
  await p.exec();
}

/**
 * Strip customer content from a finished workflow, keeping its skeleton.
 * @param {string} workflowId
 * @returns {Promise<boolean>} false if the workflow does not exist
 */
export async function scrubWorkflowContent(workflowId) {
  const steps = await redis.hgetall(K.steps(workflowId));
  const stepIds = Object.keys(steps);

  const p = redis.pipeline();
  for (const id of stepIds) {
    let step;
    try { step = JSON.parse(steps[id]); } catch { continue; }
    step.description = REDACTED;
    step.lastError = null;
    step.lastPatch = null;
    p.hset(K.steps(workflowId), id, JSON.stringify(step));
  }
  await p.exec();

  const rawMeta = await redis.get(K.meta(workflowId));
  if (rawMeta) {
    const meta = JSON.parse(rawMeta);
    for (const f of ['reason', 'cancelReason', 'task', 'description']) if (meta[f]) meta[f] = REDACTED;
    await redis.set(K.meta(workflowId), JSON.stringify(meta));
  }

  await deleteSideRecords(workflowId, stepIds);
  return stepIds.length > 0 || Boolean(rawMeta);
}

/**
 * Remove every key a workflow owns.
 * @param {string} workflowId
 */
export async function purgeWorkflow(workflowId) {
  const stepIds = await redis.hkeys(K.steps(workflowId));
  await deleteSideRecords(workflowId, stepIds);
  await redis.del(K.steps(workflowId), K.meta(workflowId));
}

/**
 * Called by workflow-store.js when a workflow reaches a terminal state.
 * No-op unless the tenant is in zero-retention mode. Never throws — the
 * retention sweeper is the backstop.
 */
export async function scrubIfZeroRetention(workflowId, tenantId) {
  try {
    if (await isZeroRetention(tenantId ?? DEFAULT_TENANT)) await scrubWorkflowContent(workflowId);
  } catch (err) {
    console.warn(`[workflow-purge] scrub failed for ${workflowId} — sweeper will retry:`, err.message);
  }
}
