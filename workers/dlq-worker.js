/**
 * dlq-worker.js
 *
 * Dedicated consumer for per-tenant dead-letter queues.
 *
 * Responsibilities:
 *   1. Consume every failed-step entry that lands in a tenant DLQ
 *   2. Apply a DLQ-level retry budget before escalating to human review
 *   3. Re-queue retryable steps into the CRITICAL priority lane
 *   4. Write a structured `needs-review` record to Redis (only after budget exhausted)
 *   5. Emit structured alerts on first arrival AND on stale unresolved items
 *   6. Run a periodic staleness sweep to re-alert on items nobody has looked at
 *
 * DLQ retry budget
 * ─────────────────
 * Each DLQ entry carries a `dlqAttempt` counter (starts at 1).  The worker
 * re-queues the step into the CRITICAL lane up to DLQ_MAX_RETRIES times with
 * exponential back-off before finally routing to human review.  This gives a
 * second chance for transient failures (network blips, rate limits, flaky
 * tests) that outlasted the agent-worker's own retry policy.
 *
 * Human triage happens via:
 *   GET  /review-queue                          → list all pending review items
 *   POST /review/:workflowId/:stepId/resolve    → mark resolved (retry | skip | escalate)
 */

import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { flagForReview, getReviewQueue } from '../engine/workflow-store.js';
import { resetStepForRetry } from '../engine/workflow-store.js';
import { addStep, Priority } from '../engine/queue.js';
import { logger } from '../engine/logger.js';
import { DEFAULT_TENANT, assertTenantId } from '../engine/tenant.js';

const connection = new IORedis();

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * How many times the DLQ worker will re-queue a failed step before
 * routing it to human review.  Each retry goes into the CRITICAL lane
 * so it jumps ahead of normal work.
 */
const DLQ_MAX_RETRIES = parseInt(process.env.DLQ_MAX_RETRIES ?? '2', 10);

/**
 * Base delay (ms) before the first DLQ retry.  Doubles each attempt.
 *   attempt 1 → DLQ_BASE_DELAY_MS
 *   attempt 2 → DLQ_BASE_DELAY_MS * 2
 * Capped at 5 minutes.
 */
const DLQ_BASE_DELAY_MS = parseInt(process.env.DLQ_BASE_DELAY_MS ?? '30000', 10);

/**
 * How often (ms) the staleness sweep runs per tenant.
 * Default: every 15 minutes.
 */
const STALE_SWEEP_INTERVAL_MS = parseInt(
  process.env.DLQ_STALE_SWEEP_MS ?? String(15 * 60 * 1000), 10
);

/**
 * A review item is "stale" when it has been pending for longer than this.
 * Default: 1 hour.
 */
const STALE_THRESHOLD_MS = parseInt(
  process.env.DLQ_STALE_THRESHOLD_MS ?? String(60 * 60 * 1000), 10
);

// ─── Back-off calculator ──────────────────────────────────────────────────────

/**
 * Exponential back-off for DLQ retries, capped at 5 minutes.
 * @param {number} dlqAttempt  1-based attempt number
 * @returns {number} delay in ms
 */
function dlqBackoffMs(dlqAttempt) {
  return Math.min(DLQ_BASE_DELAY_MS * Math.pow(2, dlqAttempt - 1), 5 * 60 * 1000);
}

// ─── Alert emitter ────────────────────────────────────────────────────────────

/**
 * Emit a structured alert to stderr and optionally to a webhook.
 * stderr is machine-readable JSON — easy to pipe into PagerDuty, Slack, etc.
 *
 * @param {object} payload   - alert body fields
 * @param {string} [level]   - 'ALERT' | 'CRITICAL' | 'WARN'
 */
async function emitAlert(payload, level = 'ALERT') {
  const alert = {
    level,
    source: 'aegis-dlq',
    timestamp: new Date().toISOString(),
    ...payload,
  };

  process.stderr.write(JSON.stringify(alert) + '\n');

  const webhookUrl = process.env.AEGIS_ALERT_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
    } catch (err) {
      logger.error({ err: err.message, webhookUrl }, 'Alert webhook delivery failed');
    }
  }

  return alert;
}

// ─── Staleness sweep ──────────────────────────────────────────────────────────

/**
 * Scan the review queue for items that have been pending longer than
 * STALE_THRESHOLD_MS and re-emit an alert for each.
 *
 * This catches the "dead items sit until someone queries /review-queue"
 * failure mode by proactively pushing alerts at regular intervals.
 *
 * @param {string} tenantId
 */
async function sweepStaleReviewItems(tenantId) {
  let items;
  try {
    items = await getReviewQueue({ status: 'pending', limit: 200 });
  } catch (err) {
    logger.error({ tenantId, err: err.message }, 'Stale sweep: failed to fetch review queue');
    return;
  }

  const now = Date.now();
  const stale = items.filter(
    item => item.tenantId === tenantId && now - (item.flaggedAt ?? 0) > STALE_THRESHOLD_MS
  );

  if (stale.length === 0) return;

  logger.warn({ tenantId, count: stale.length }, 'Stale review items detected');

  for (const item of stale) {
    await emitAlert(
      {
        tenantId,
        workflowId: item.workflowId,
        stepId:     item.stepId,
        agent:      item.agent,
        flaggedAt:  new Date(item.flaggedAt).toISOString(),
        staleSinceMs: now - item.flaggedAt,
        message: `Review item for step "${item.stepId}" in workflow "${item.workflowId}" ` +
                 `(tenant: ${tenantId}) has been pending for ` +
                 `${Math.round((now - item.flaggedAt) / 60_000)} minutes — no human has acted on it.`,
      },
      'WARN'
    );
  }
}

// ─── Per-tenant DLQ worker factory ───────────────────────────────────────────

const _dlqWorkers   = new Map();
const _sweepTimers  = new Map();

export function getDlqWorker(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  if (_dlqWorkers.has(tenantId)) return _dlqWorkers.get(tenantId);

  const dlqName = `aegis-dead-letter:${tenantId}`;

  const worker = new Worker(
    dlqName,
    async (job) => {
      const entry = job.data;

      // dlqAttempt tracks how many times this specific entry has cycled
      // through the DLQ worker.  Starts at 1 on first arrival.
      const dlqAttempt = (entry.dlqAttempt ?? 0) + 1;

      logger.info(
        {
          jobId: job.id, tenantId,
          workflowId: entry.workflowId,
          stepId:     entry.step?.id,
          dlqAttempt,
          dlqMaxRetries: DLQ_MAX_RETRIES,
        },
        'DLQ entry received'
      );

      // ── Retry budget: re-queue into CRITICAL lane ────────────────────────
      if (dlqAttempt <= DLQ_MAX_RETRIES) {
        const delayMs = dlqBackoffMs(dlqAttempt);

        await emitAlert({
          tenantId,
          workflowId:   entry.workflowId,
          stepId:       entry.step?.id ?? 'unknown',
          agent:        entry.step?.agent ?? 'unknown',
          dlqAttempt,
          dlqMaxRetries: DLQ_MAX_RETRIES,
          retryDelayMs: delayMs,
          error:        entry.error,
          message:
            `DLQ retry ${dlqAttempt}/${DLQ_MAX_RETRIES} for step "${entry.step?.id}" ` +
            `in workflow "${entry.workflowId}" (tenant: ${tenantId}) — ` +
            `re-queuing at CRITICAL priority in ${delayMs}ms.`,
        });

        // Reset the step's internal attempt counter so the agent-worker's
        // own retry logic starts fresh from attempt=1 (not from attempt=N+1).
        const resetStep = await resetStepForRetry(entry.workflowId, entry.step?.id);

        // Schedule the step back into the CRITICAL lane after back-off delay.
        // BullMQ's `delay` option defers job processing by the given ms.
        await addStep(
          entry.workflowId,
          resetStep ?? entry.step,
          Priority.CRITICAL,
          tenantId,
          { delay: delayMs }
        );

        logger.info(
          { tenantId, workflowId: entry.workflowId, stepId: entry.step?.id, dlqAttempt, delayMs },
          'DLQ step re-queued at CRITICAL priority'
        );

        return { requeued: true, dlqAttempt, delayMs };
      }

      // ── Budget exhausted: escalate to human review ───────────────────────
      const alert = await emitAlert(
        {
          level:        'CRITICAL',
          tenantId,
          workflowId:   entry.workflowId,
          stepId:       entry.step?.id ?? 'unknown',
          agent:        entry.step?.agent ?? 'unknown',
          originalJobId: entry.originalJobId,
          dlqAttempt,
          error:        entry.error,
          retryPolicy:  entry.step?.retryPolicy ?? 'standard',
          message:
            `Step "${entry.step?.id}" in workflow "${entry.workflowId}" ` +
            `(tenant: ${tenantId}) exhausted ${DLQ_MAX_RETRIES} DLQ retries — ` +
            'routing to human review.',
        },
        'CRITICAL'
      );

      await flagForReview(entry.workflowId, entry.step?.id, {
        error:         entry.error,
        originalJobId: entry.originalJobId,
        agent:         entry.step?.agent,
        description:   entry.step?.description,
        retryPolicy:   entry.step?.retryPolicy,
        dlqAttempt,
        tenantId,
        flaggedAt: Date.now(),
        alert,
      });

      logger.warn(
        { tenantId, workflowId: entry.workflowId, stepId: entry.step?.id, dlqAttempt },
        'DLQ budget exhausted — flagged for human review'
      );

      return { processed: true, humanReview: true, dlqAttempt };
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    process.stderr.write(
      JSON.stringify({
        level:     'CRITICAL',
        source:    'aegis-dlq-worker',
        timestamp: new Date().toISOString(),
        tenantId,
        jobId:     job?.id,
        error:     err.message,
        message:
          `DLQ worker for tenant "${tenantId}" failed to process a dead-letter entry — ` +
          'manual inspection required',
      }) + '\n'
    );
  });

  _dlqWorkers.set(tenantId, worker);
  logger.info(`DLQ worker started — consuming ${dlqName}`);

  // ── Staleness sweep timer ────────────────────────────────────────────────
  // Re-alert on review items that nobody has acted on within STALE_THRESHOLD_MS.
  const sweepTimer = setInterval(
    () => sweepStaleReviewItems(tenantId).catch(err =>
      logger.error({ tenantId, err: err.message }, 'Stale sweep error')
    ),
    STALE_SWEEP_INTERVAL_MS
  );
  sweepTimer.unref(); // don't keep the process alive solely for the sweep
  _sweepTimers.set(tenantId, sweepTimer);

  return worker;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const TENANTS = (process.env.AEGIS_TENANTS ?? DEFAULT_TENANT)
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

for (const tenant of TENANTS) {
  getDlqWorker(tenant);
  console.log(`[dlq-worker] Listening on aegis-dead-letter:${tenant}`);
  console.log(`[dlq-worker] DLQ retry budget: ${DLQ_MAX_RETRIES} attempt(s) before human review`);
  console.log(`[dlq-worker] Stale-item sweep every ${STALE_SWEEP_INTERVAL_MS / 1000}s`);
}
