import IORedis from 'ioredis';
import { clearSlots } from './concurrency.js';

import { trackWorkflowEnd } from './tenant-quota.js';

const redis = new IORedis();

const WORKFLOW_PREFIX = 'aegis:workflow:';
const META_PREFIX = 'aegis:workflow:meta:';
const EVENTS_PREFIX = 'aegis:workflow:events:';

/**
 * Publish a terminal/control status change so event-driven waiters (e.g. the
 * CLI) don't have to poll. Best-effort — a missed publish just means the
 * waiter falls back to its own timeout, so failures here are swallowed.
 */
function publishWorkflowEvent(workflowId, status) {
  redis.publish(EVENTS_PREFIX + workflowId, JSON.stringify({ status, at: Date.now() })).catch(() => {});
}

// ─── Tenant ownership enforcement ─────────────────────────────────────────────

/**
 * Load the meta record for a workflow and verify it belongs to `tenantId`.
 * Returns the parsed meta object, or null when the workflow does not exist.
 * Throws a TenantMismatchError when the workflow exists but belongs to a
 * different tenant — the caller must treat this as a 403, not a 404, to
 * prevent information-leakage through timing differences.
 *
 * Pass tenantId=null to skip the ownership check (internal-only callers such
 * as the DLQ worker that don't have a resolved tenant context).
 *
 * @param {string}      workflowId
 * @param {string|null} tenantId
 * @returns {Promise<object|null>}
 */
async function loadMetaWithOwnerCheck(workflowId, tenantId) {
  const metaRaw = await redis.get(META_PREFIX + workflowId);
  if (!metaRaw) return null;

  const meta = JSON.parse(metaRaw);

  if (tenantId !== null && meta.tenantId !== null && meta.tenantId !== tenantId) {
    throw new TenantMismatchError(
      `Workflow "${workflowId}" does not belong to tenant "${tenantId}".`
    );
  }

  return meta;
}

export class TenantMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantMismatchError';
    this.code = 'TENANT_MISMATCH';
  }
}

// ─── Control status values ────────────────────────────────────────────────────
// running | paused | cancelled | completed | failed | needs-review
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🆕 Create workflow
 * @param {string} workflowId
 * @param {object[]} steps
 * @param {object} opts
 * @param {number} [opts.timeoutMs]   - wall-clock timeout for the whole workflow
 * @param {number} [opts.priority]    - 0=CRITICAL 1=HIGH 5=NORMAL 10=LOW
 */
export async function createWorkflow(workflowId, steps, opts = {}) {
  const key = WORKFLOW_PREFIX + workflowId;
  const metaKey = META_PREFIX + workflowId;

  const pipeline = redis.pipeline();

  for (const step of steps) {
    pipeline.hset(
      key,
      step.id,
      JSON.stringify({
        ...step,
        status: 'pending'
      })
    );
  }

  pipeline.set(
    metaKey,
    JSON.stringify({
      id: workflowId,
      status: 'running',
      tenantId: opts.tenantId ?? null,
      priority: opts.priority ?? 5,
      timeoutMs: opts.timeoutMs ?? null,
      startedAt: Date.now(),
      createdAt: Date.now()
    })
  );

  await pipeline.exec();
}

/**
 * 🔄 Update step status
 */
export async function updateStep(workflowId, stepId, status) {
  const key = WORKFLOW_PREFIX + workflowId;

  const stepRaw = await redis.hget(key, stepId);
  if (!stepRaw) return;

  const step = JSON.parse(stepRaw);
  step.status = status;
  step.updatedAt = Date.now();

  await redis.hset(key, stepId, JSON.stringify(step));
}

/**
 * 🔄 Reset a step so a human-initiated retry starts clean.
 *
 * Unlike updateStep() (which only flips `status`), this function also
 * zeroes `attempt` so the worker's agentForAttempt() call always begins
 * at attempt=1 → the step's own agent, never escalationAgent/fallbackAgent.
 * It also clears transient error fields left over from the failed run.
 *
 * Returns the updated step object so callers can pass it straight to
 * addStep() without a second Redis round-trip.
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @returns {object|null} the reset step, or null if not found
 */
export async function resetStepForRetry(workflowId, stepId) {
  const key = WORKFLOW_PREFIX + workflowId;

  const stepRaw = await redis.hget(key, stepId);
  if (!stepRaw) return null;

  const step = JSON.parse(stepRaw);

  // Zero out all retry-state so the next worker invocation starts from scratch.
  step.status    = 'pending';
  step.attempt   = 0;        // explicit 0 — agentForAttempt(step, policy, 1) → step.agent
  step.lastError = null;
  step.lastPatch = null;
  step.updatedAt = Date.now();

  await redis.hset(key, stepId, JSON.stringify(step));

  return step;
}

/**
 * 📊 Get full workflow
 * @param {string}      workflowId
 * @param {string|null} [tenantId]  - pass the resolved tenant to enforce ownership
 */
export async function getWorkflow(workflowId, tenantId = null) {
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) return null;

  const stepsRaw = await redis.hgetall(WORKFLOW_PREFIX + workflowId);
  const steps = Object.values(stepsRaw).map(JSON.parse);

  return { ...meta, steps };
}

/**
 * 🔍 Get runnable steps (dependency-aware)
 */
export async function getRunnableSteps(workflowId) {
  const key = WORKFLOW_PREFIX + workflowId;

  const stepsRaw = await redis.hgetall(key);
  const steps = Object.values(stepsRaw).map(JSON.parse);

  return steps.filter(step => {
    if (step.status !== 'pending') return false;

    if (!step.depends_on || step.depends_on.length === 0) return true;

    return step.depends_on.every(dep => {
      const depStep = steps.find(s => s.id === dep);
      return depStep && depStep.status === 'completed';
    });
  });
}

/**
 * ❌ Mark entire workflow failed (optional helper)
 */
export async function failWorkflow(workflowId, reason) {
  const metaKey = META_PREFIX + workflowId;

  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return;

  const meta = JSON.parse(metaRaw);
  meta.status = 'failed';
  meta.reason = reason;
  meta.failedAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));

  // Release any lingering concurrency slots
  await clearSlots(workflowId);

  // Decrement the tenant's active-workflow counter
  if (meta.tenantId) {
    await trackWorkflowEnd(meta.tenantId).catch(() => {});
  }

  publishWorkflowEvent(workflowId, 'failed');
}

/**
 * ✅ Mark entire workflow completed. Called once all steps have finished and
 * (where applicable) the workflow branch has been merged.
 * @param {string} workflowId
 */
export async function completeWorkflow(workflowId) {
  const metaKey = META_PREFIX + workflowId;

  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return;

  const meta = JSON.parse(metaRaw);
  if (meta.status === 'completed' || meta.status === 'failed') return;

  meta.status = 'completed';
  meta.completedAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));

  await clearSlots(workflowId);

  if (meta.tenantId) {
    await trackWorkflowEnd(meta.tenantId).catch(() => {});
  }

  publishWorkflowEvent(workflowId, 'completed');
}

/**
 * ⏸ Pause a running workflow.
 * In-flight steps finish their current attempt; no new steps are scheduled.
 * @param {string}      workflowId
 * @param {string|null} [tenantId]  - pass the resolved tenant to enforce ownership
 */
export async function pauseWorkflow(workflowId, tenantId = null) {
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) return false;
  if (meta.status !== 'running') return false;

  meta.status = 'paused';
  meta.pausedAt = Date.now();

  await redis.set(META_PREFIX + workflowId, JSON.stringify(meta));
  return true;
}

/**
 * ▶️ Resume a paused workflow.
 * Caller is responsible for re-scheduling runnable steps after this.
 * @param {string}      workflowId
 * @param {string|null} [tenantId]  - pass the resolved tenant to enforce ownership
 */
export async function resumeWorkflow(workflowId, tenantId = null) {
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) return false;
  if (meta.status !== 'paused') return false;

  meta.status = 'running';
  meta.resumedAt = Date.now();
  delete meta.pausedAt;

  await redis.set(META_PREFIX + workflowId, JSON.stringify(meta));
  return true;
}

/**
 * 🛑 Cancel a workflow.
 * Running steps detect this at their next control-check and abort.
 * No new steps are scheduled.
 * @param {string}      workflowId
 * @param {string}      [reason]
 * @param {string|null} [tenantId]  - pass the resolved tenant to enforce ownership
 */
export async function cancelWorkflow(workflowId, reason = 'user request', tenantId = null) {
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) return false;
  if (meta.status === 'cancelled' || meta.status === 'completed') return false;

  meta.status = 'cancelled';
  meta.cancelReason = reason;
  meta.cancelledAt = Date.now();

  await redis.set(META_PREFIX + workflowId, JSON.stringify(meta));

  // Release all held concurrency slots
  await clearSlots(workflowId);

  // Decrement the tenant's active-workflow counter
  if (meta.tenantId) {
    await trackWorkflowEnd(meta.tenantId).catch(() => {});
  }

  publishWorkflowEvent(workflowId, 'cancelled');

  return true;
}

/**
 * 📋 Get workflow control status (running | paused | cancelled | completed | failed)
 * @param {string}      workflowId
 * @param {string|null} [tenantId]  - pass the resolved tenant to enforce ownership
 */
export async function getWorkflowStatus(workflowId, tenantId = null) {
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) return null;
  return meta.status ?? null;
}

/**
 * ⏱ Check if workflow has exceeded its configured timeoutMs.
 * Returns true if timed out, false otherwise.
 */
export async function isWorkflowTimedOut(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (!meta.timeoutMs) return false;

  return Date.now() - meta.startedAt > meta.timeoutMs;
}

// ─── Human-in-the-loop review queue ──────────────────────────────────────────

const REVIEW_PREFIX = 'aegis:review:';
const REVIEW_INDEX  = 'aegis:review:index';

/**
 * 🚩 Flag a step for human review.
 * Called by the DLQ worker after all retries are exhausted.
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @param {object} details  - error, agent, description, flaggedAt, alert, etc.
 */
export async function flagForReview(workflowId, stepId, details = {}) {
  const reviewKey = `${REVIEW_PREFIX}${workflowId}:${stepId}`;

  const record = {
    workflowId,
    stepId,
    status: 'pending',        // pending | resolved | skipped | retrying
    ...details,
    flaggedAt: details.flaggedAt ?? Date.now()
  };

  const pipeline = redis.pipeline();

  // Store the review record
  pipeline.set(reviewKey, JSON.stringify(record));

  // Add to the sorted index (score = flaggedAt for time-ordered retrieval)
  pipeline.zadd(REVIEW_INDEX, record.flaggedAt, reviewKey);

  await pipeline.exec();

  return record;
}

/**
 * 📋 Get all items currently pending human review, newest first.
 *
 * @param {object} opts
 * @param {number} [opts.limit=50]   - max items to return
 * @param {string} [opts.status]     - filter by status (default: 'pending')
 * @returns {object[]} review records
 */
export async function getReviewQueue({ limit = 50, status = 'pending' } = {}) {
  // Retrieve keys in reverse chronological order (highest score = most recent)
  const keys = await redis.zrevrange(REVIEW_INDEX, 0, limit - 1);
  if (!keys.length) return [];

  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.get(key);
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw)))
    .filter(r => r !== null && (!status || r.status === status));
}

/**
 * ✅ Resolve a review item.
 * resolution: 'resolved' | 'skipped' | 'retrying'
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @param {string} resolution
 * @param {string} [note]  - optional human note
 */
export async function resolveReview(workflowId, stepId, resolution, note = '') {
  const reviewKey = `${REVIEW_PREFIX}${workflowId}:${stepId}`;

  const raw = await redis.get(reviewKey);
  if (!raw) return false;

  const record = JSON.parse(raw);
  record.status = resolution;
  record.resolvedAt = Date.now();
  record.note = note;

  await redis.set(reviewKey, JSON.stringify(record));
  return record;
}

// ─── Workflow listing ─────────────────────────────────────────────────────────

/**
 * 📋 List workflows with optional filtering and pagination.
 *
 * Uses SCAN to iterate over all `aegis:workflow:meta:*` keys so it is
 * non-blocking even on large Redis instances (no KEYS call).
 *
 * @param {object} opts
 * @param {string}   [opts.status]      - filter by status (running | paused | cancelled | completed | failed | needs-review)
 * @param {string}   [opts.tenantId]    - filter by tenant
 * @param {number}   [opts.limit=50]    - max workflows to return (applied after filters)
 * @param {string}   [opts.cursor='0']  - SCAN cursor for pagination (pass value returned by previous call)
 * @returns {{ workflows: object[], nextCursor: string }}
 *   nextCursor is '0' when the full keyspace has been traversed.
 */
export async function listWorkflows({
  status    = null,
  tenantId  = null,
  limit     = 50,
  cursor    = '0'
} = {}) {
  const collected = [];
  let   scanCursor = cursor;

  // SCAN until we have enough results or exhaust the keyspace.
  // Each SCAN call returns ~100 keys (Redis default COUNT hint).
  do {
    const [nextCursor, keys] = await redis.scan(
      scanCursor,
      'MATCH', `${META_PREFIX}*`,
      'COUNT', 100
    );
    scanCursor = nextCursor;

    if (!keys.length) continue;

    // Batch-fetch all meta records in this page
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.get(key);
    const results = await pipeline.exec();

    for (const [err, raw] of results) {
      if (err || !raw) continue;
      const meta = JSON.parse(raw);

      if (status   && meta.status   !== status)   continue;
      if (tenantId && meta.tenantId !== tenantId) continue;

      collected.push(meta);
      if (collected.length >= limit) break;
    }
  } while (scanCursor !== '0' && collected.length < limit);

  // Sort newest-first by default
  collected.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return {
    workflows:  collected,
    nextCursor: scanCursor   // '0' = fully traversed; anything else = more pages
  };
}

// ─── Step rewind ──────────────────────────────────────────────────────────────

const REWIND_HISTORY_PREFIX = 'aegis:rewind:';
const REWIND_INDEX_PREFIX   = 'aegis:rewind:index:';

/**
 * 🔁 Rewind a completed step.
 *
 * Resets the target step and all downstream completed steps back to 'pending'
 * so they re-execute on the next workflow resume.  Records an audit entry in
 * the rewind history.
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @param {object} [opts]
 * @param {string|null} [opts.commitHash]  - git commit that was reverted (for audit)
 * @param {string}      [opts.reason]      - human-readable reason
 * @param {string|null} [opts.tenantId]    - enforce ownership when provided
 * @returns {Promise<{ ok: boolean, reason?: string, resetSteps?: string[] }>}
 */
export async function rewindStep(workflowId, stepId, {
  commitHash = null,
  reason     = 'manual rewind',
  tenantId   = null,
} = {}) {
  // Ownership check
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) {
    return { ok: false, reason: `Workflow "${workflowId}" not found.` };
  }

  const key      = WORKFLOW_PREFIX + workflowId;
  const stepsRaw = await redis.hgetall(key);
  if (!stepsRaw || Object.keys(stepsRaw).length === 0) {
    return { ok: false, reason: `Workflow "${workflowId}" has no steps.` };
  }

  const steps = Object.values(stepsRaw).map(JSON.parse);
  const target = steps.find(s => s.id === stepId);

  if (!target) {
    return { ok: false, reason: `Step "${stepId}" not found in workflow "${workflowId}".` };
  }

  if (target.status !== 'completed') {
    return {
      ok:     false,
      reason: `Step "${stepId}" cannot be rewound — current status is "${target.status}". ` +
              `Only completed steps can be rewound.`,
    };
  }

  // Collect the target step and all downstream steps (those that depend on it
  // directly or transitively) that are already completed.
  const resetIds = new Set([stepId]);

  // BFS over the dependency graph to find all downstream steps
  let frontier = [stepId];
  while (frontier.length) {
    const next = [];
    for (const s of steps) {
      if (resetIds.has(s.id)) continue;
      if (s.depends_on && s.depends_on.some(dep => frontier.includes(dep))) {
        if (s.status === 'completed') {
          resetIds.add(s.id);
          next.push(s.id);
        }
      }
    }
    frontier = next;
  }

  // Reset all collected steps to pending in a single pipeline
  const now = Date.now();
  const pipeline = redis.pipeline();
  for (const s of steps) {
    if (!resetIds.has(s.id)) continue;
    const updated = {
      ...s,
      status:    'pending',
      attempt:   0,
      lastError: null,
      lastPatch: null,
      updatedAt: now,
    };
    pipeline.hset(key, s.id, JSON.stringify(updated));
  }
  await pipeline.exec();

  // Persist audit record
  const auditRecord = {
    workflowId,
    stepId,
    resetSteps:  [...resetIds],
    commitHash,
    reason,
    rewindAt:    now,
    tenantId:    meta.tenantId ?? null,
  };
  const auditKey   = `${REWIND_HISTORY_PREFIX}${workflowId}:${now}`;
  const indexKey   = `${REWIND_INDEX_PREFIX}${workflowId}`;

  await redis.pipeline()
    .set(auditKey, JSON.stringify(auditRecord))
    .zadd(indexKey, now, auditKey)
    .exec();

  return { ok: true, resetSteps: [...resetIds] };
}

/**
 * 📜 Get the rewind audit trail for a workflow, newest first.
 *
 * @param {string}      workflowId
 * @param {string|null} [tenantId]  - enforce ownership when provided
 * @param {number}      [limit=50]
 * @returns {Promise<object[]>}
 */
export async function getRewindHistory(workflowId, tenantId = null, limit = 50) {
  // Ownership check
  const meta = await loadMetaWithOwnerCheck(workflowId, tenantId);
  if (!meta) return [];

  const indexKey = `${REWIND_INDEX_PREFIX}${workflowId}`;
  const keys = await redis.zrevrange(indexKey, 0, limit - 1);
  if (!keys.length) return [];

  const pipeline = redis.pipeline();
  for (const k of keys) pipeline.get(k);
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw)))
    .filter(Boolean);
}
