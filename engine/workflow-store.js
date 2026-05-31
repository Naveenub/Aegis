import IORedis from 'ioredis';
import { clearSlots } from './concurrency.js';

const redis = new IORedis();

const WORKFLOW_PREFIX = 'aegis:workflow:';
const META_PREFIX = 'aegis:workflow:meta:';

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
 */
export async function getWorkflow(workflowId) {
  const key = WORKFLOW_PREFIX + workflowId;
  const metaKey = META_PREFIX + workflowId;

  const [stepsRaw, metaRaw] = await Promise.all([
    redis.hgetall(key),
    redis.get(metaKey)
  ]);

  if (!metaRaw) return null;

  const steps = Object.values(stepsRaw).map(JSON.parse);
  const meta = JSON.parse(metaRaw);

  return {
    ...meta,
    steps
  };
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
}

/**
 * ⏸ Pause a running workflow.
 * In-flight steps finish their current attempt; no new steps are scheduled.
 */
export async function pauseWorkflow(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (meta.status !== 'running') return false;

  meta.status = 'paused';
  meta.pausedAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));
  return true;
}

/**
 * ▶️ Resume a paused workflow.
 * Caller is responsible for re-scheduling runnable steps after this.
 */
export async function resumeWorkflow(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (meta.status !== 'paused') return false;

  meta.status = 'running';
  meta.resumedAt = Date.now();
  delete meta.pausedAt;

  await redis.set(metaKey, JSON.stringify(meta));
  return true;
}

/**
 * 🛑 Cancel a workflow.
 * Running steps detect this at their next control-check and abort.
 * No new steps are scheduled.
 */
export async function cancelWorkflow(workflowId, reason = 'user request') {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (meta.status === 'cancelled' || meta.status === 'completed') return false;

  meta.status = 'cancelled';
  meta.cancelReason = reason;
  meta.cancelledAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));

  // Release all held concurrency slots so no future workflow with this id stalls
  await clearSlots(workflowId);

  return true;
}

/**
 * 📋 Get workflow control status (running | paused | cancelled | completed | failed)
 */
export async function getWorkflowStatus(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return null;
  return JSON.parse(metaRaw).status ?? null;
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

// ─── Step Rewind (NEW) ────────────────────────────────────────────────────────
//
// A "rewind" reverts a completed step back to pending so it can be re-executed.
// The git layer handles the actual `git revert`; this module handles the Redis
// state machine and records an audit trail of all rewind operations.
//
// Constraints enforced here:
//   • Only `completed` steps can be rewound — rewinding a running/pending step
//     is a no-op race that would corrupt the workflow.
//   • Downstream steps (steps that depend_on the rewound step) are reset to
//     `pending` automatically so the DAG stays consistent.
//   • The workflow must be in `running` or `paused` state (not cancelled/completed).

const REWIND_PREFIX = 'aegis:rewind:';

/**
 * Rewind a completed step back to `pending` and reset any downstream steps
 * that already completed as a result of it.
 *
 * Called by the POST /workflows/:workflowId/steps/:stepId/rewind handler AFTER
 * the git revert has succeeded.  The handler acquires the worktree lock before
 * calling this function, so there is no race between the git op and this write.
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @param {object} opts
 * @param {string} [opts.commitHash]  - the commit that was reverted (for audit)
 * @param {string} [opts.reason]      - human note
 * @returns {{ ok: boolean, resetSteps: string[] }}
 */
export async function rewindStep(workflowId, stepId, opts = {}) {
  const key     = WORKFLOW_PREFIX + workflowId;
  const metaKey = META_PREFIX     + workflowId;

  // ── Guard: workflow must exist and be rewindable ────────────────────────────
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return { ok: false, reason: 'workflow not found' };

  const meta = JSON.parse(metaRaw);
  if (!['running', 'paused'].includes(meta.status)) {
    return { ok: false, reason: `workflow is ${meta.status} — cannot rewind` };
  }

  // ── Guard: target step must be `completed` ──────────────────────────────────
  const stepRaw = await redis.hget(key, stepId);
  if (!stepRaw) return { ok: false, reason: 'step not found' };

  const step = JSON.parse(stepRaw);
  if (step.status !== 'completed') {
    return { ok: false, reason: `step is "${step.status}" — only completed steps can be rewound` };
  }

  // ── Collect all steps to reset ──────────────────────────────────────────────
  // The rewound step itself + any downstream step whose depends_on chain
  // includes the rewound step (direct or transitive dependency).
  const allStepsRaw = await redis.hgetall(key);
  const allSteps    = Object.values(allStepsRaw).map(JSON.parse);

  /**
   * Returns true if `candidate` has a transitive dependency on `targetId`.
   */
  function dependsOn(candidate, targetId, visited = new Set()) {
    if (visited.has(candidate.id)) return false;
    visited.add(candidate.id);
    for (const dep of (candidate.depends_on ?? [])) {
      if (dep === targetId) return true;
      const depStep = allSteps.find(s => s.id === dep);
      if (depStep && dependsOn(depStep, targetId, visited)) return true;
    }
    return false;
  }

  const stepsToReset = allSteps.filter(
    s => s.id === stepId ||
         (s.status === 'completed' && dependsOn(s, stepId))
  );

  // ── Apply resets ────────────────────────────────────────────────────────────
  const now      = Date.now();
  const pipeline = redis.pipeline();

  for (const s of stepsToReset) {
    const updated = {
      ...s,
      status:      'pending',
      attempt:     0,
      lastError:   null,
      lastPatch:   null,
      rewindedAt:  now,
      updatedAt:   now,
    };
    pipeline.hset(key, s.id, JSON.stringify(updated));
  }

  // ── Write audit record ──────────────────────────────────────────────────────
  const rewindRecord = {
    workflowId,
    stepId,
    resetSteps:  stepsToReset.map(s => s.id),
    commitHash:  opts.commitHash ?? null,
    reason:      opts.reason     ?? 'user request',
    rewindedAt:  now,
  };

  const rewindKey = `${REWIND_PREFIX}${workflowId}:${stepId}:${now}`;
  pipeline.set(rewindKey, JSON.stringify(rewindRecord));

  // ── If workflow was paused, flip back to running so the reset steps execute ─
  // (Only when the caller is a user-initiated rewind, not an automated retry.)
  // We do NOT auto-resume here — the caller decides whether to resume.

  await pipeline.exec();

  return {
    ok:         true,
    resetSteps: stepsToReset.map(s => s.id),
    rewindRecord,
  };
}

/**
 * Return the rewind audit trail for a workflow, newest first.
 *
 * @param {string} workflowId
 * @returns {object[]}
 */
export async function getRewindHistory(workflowId) {
  const pattern = `${REWIND_PREFIX}${workflowId}:*`;
  let   cursor  = '0';
  const keys    = [];

  do {
    const [next, found] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    keys.push(...found);
  } while (cursor !== '0');

  if (!keys.length) return [];

  const pipeline = redis.pipeline();
  for (const k of keys) pipeline.get(k);
  const results = await pipeline.exec();

  return results
    .map(([err, raw]) => (err || !raw ? null : JSON.parse(raw)))
    .filter(Boolean)
    .sort((a, b) => b.rewindedAt - a.rewindedAt);
}
