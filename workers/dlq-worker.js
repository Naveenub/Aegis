/**
 * dlq-worker.js
 *
 * Dedicated consumer for the aegis-dead-letter queue.
 *
 * Responsibilities:
 *   1. Consume every failed-step entry that lands in DLQ
 *   2. Write a structured `needs-review` record to Redis
 *   3. Emit a structured alert (stderr JSON — webhook-ready)
 *   4. Optionally POST to AEGIS_ALERT_WEBHOOK if configured
 *
 * Human triage happens via:
 *   GET  /review-queue                          → list all pending review items
 *   POST /review/:workflowId/:stepId/resolve    → mark resolved (retry | skip | escalate)
 */

import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { flagForReview } from '../engine/workflow-store.js';
import { logger } from '../engine/logger.js';

const connection = new IORedis();

// ─── Alert emitter ────────────────────────────────────────────────────────────

/**
 * Emit a structured alert to stderr (always) and optionally to a webhook.
 * stderr is machine-readable JSON — easy to pipe into PagerDuty, Slack, etc.
 */
async function emitAlert(entry) {
  const alert = {
    level: 'ALERT',
    source: 'aegis-dlq',
    timestamp: new Date().toISOString(),
    workflowId: entry.workflowId,
    stepId: entry.step?.id ?? 'unknown',
    agent: entry.step?.agent ?? 'unknown',
    originalJobId: entry.originalJobId,
    error: entry.error,
    retryPolicy: entry.step?.retryPolicy ?? 'standard',
    message: `Step "${entry.step?.id}" in workflow "${entry.workflowId}" exhausted all retries and requires human review.`
  };

  // Always write to stderr as structured JSON — log aggregators pick this up
  process.stderr.write(JSON.stringify(alert) + '\n');

  // Webhook delivery (optional — set AEGIS_ALERT_WEBHOOK in env)
  const webhookUrl = process.env.AEGIS_ALERT_WEBHOOK;
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert)
      });
    } catch (err) {
      // Webhook failure must never crash the DLQ worker
      logger.error({ err: err.message, webhookUrl }, 'Alert webhook delivery failed');
    }
  }

  return alert;
}

// ─── DLQ Worker ──────────────────────────────────────────────────────────────

const dlqWorker = new Worker(
  'aegis-dead-letter',
  async (job) => {
    const entry = job.data;

    logger.info(
      { jobId: job.id, workflowId: entry.workflowId, stepId: entry.step?.id },
      'DLQ entry received'
    );

    // 1. Emit alert immediately
    const alert = await emitAlert(entry);

    // 2. Write to Redis review queue — human triage API reads from here
    await flagForReview(entry.workflowId, entry.step?.id, {
      error: entry.error,
      originalJobId: entry.originalJobId,
      agent: entry.step?.agent,
      description: entry.step?.description,
      retryPolicy: entry.step?.retryPolicy,
      flaggedAt: Date.now(),
      alert
    });

    logger.info(
      { workflowId: entry.workflowId, stepId: entry.step?.id },
      'Flagged for human review'
    );

    return { processed: true };
  },
  { connection }
);

dlqWorker.on('failed', (job, err) => {
  // DLQ worker itself failed — last-resort stderr dump
  process.stderr.write(JSON.stringify({
    level: 'CRITICAL',
    source: 'aegis-dlq-worker',
    timestamp: new Date().toISOString(),
    jobId: job?.id,
    error: err.message,
    message: 'DLQ worker failed to process a dead-letter entry — manual inspection required'
  }) + '\n');
});

logger.info('DLQ worker started — consuming aegis-dead-letter');
