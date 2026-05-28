/**
 * dlq-worker.js
 *
 * Dedicated consumer for per-tenant dead-letter queues.
 *
 * Responsibilities:
 *   1. Consume every failed-step entry that lands in a tenant DLQ
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
import { getDeadLetterQueue } from '../engine/queue.js';
import { DEFAULT_TENANT, assertTenantId } from '../engine/tenant.js';

const connection = new IORedis();

// ─── Alert emitter ────────────────────────────────────────────────────────────

/**
 * Emit a structured alert to stderr (always) and optionally to a webhook.
 * stderr is machine-readable JSON — easy to pipe into PagerDuty, Slack, etc.
 */
async function emitAlert(entry, tenantId) {
  const alert = {
    level: 'ALERT',
    source: 'aegis-dlq',
    timestamp: new Date().toISOString(),
    tenantId,
    workflowId: entry.workflowId,
    stepId: entry.step?.id ?? 'unknown',
    agent: entry.step?.agent ?? 'unknown',
    originalJobId: entry.originalJobId,
    error: entry.error,
    retryPolicy: entry.step?.retryPolicy ?? 'standard',
    message: `Step "${entry.step?.id}" in workflow "${entry.workflowId}" (tenant: ${tenantId}) exhausted all retries and requires human review.`
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

// ─── Per-tenant DLQ worker factory ───────────────────────────────────────────
// BullMQ workers bind to a single named queue at construction time.
// Each tenant's failed steps are routed to "aegis-dead-letter:{tenantId}" by
// agent-worker.js via getDeadLetterQueue(tenantId). We must therefore spin up
// one Worker instance per tenant — mirroring the agent-worker factory pattern —
// rather than one global worker on the bare "aegis-dead-letter" queue (which
// no tenant ever writes to).
//
// Workers are created lazily on first call and cached for the process lifetime.

const _dlqWorkers = new Map();

export function getDlqWorker(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  if (_dlqWorkers.has(tenantId)) return _dlqWorkers.get(tenantId);

  // Derive the queue name the same way queue.js does, so the worker binds to
  // exactly the queue that agent-worker.js writes to for this tenant.
  const dlqName = `aegis-dead-letter:${tenantId}`;

  const worker = new Worker(
    dlqName,
    async (job) => {
      const entry = job.data;

      logger.info(
        { jobId: job.id, tenantId, workflowId: entry.workflowId, stepId: entry.step?.id },
        'DLQ entry received'
      );

      // 1. Emit alert immediately (includes tenantId for alerting pipelines)
      const alert = await emitAlert(entry, tenantId);

      // 2. Write to Redis review queue — human triage API reads from here
      await flagForReview(entry.workflowId, entry.step?.id, {
        error: entry.error,
        originalJobId: entry.originalJobId,
        agent: entry.step?.agent,
        description: entry.step?.description,
        retryPolicy: entry.step?.retryPolicy,
        tenantId,
        flaggedAt: Date.now(),
        alert
      });

      logger.info(
        { tenantId, workflowId: entry.workflowId, stepId: entry.step?.id },
        'Flagged for human review'
      );

      return { processed: true };
    },
    { connection }
  );

  worker.on('failed', (job, err) => {
    // DLQ worker itself failed — last-resort stderr dump
    process.stderr.write(JSON.stringify({
      level: 'CRITICAL',
      source: 'aegis-dlq-worker',
      timestamp: new Date().toISOString(),
      tenantId,
      jobId: job?.id,
      error: err.message,
      message: `DLQ worker for tenant "${tenantId}" failed to process a dead-letter entry — manual inspection required`
    }) + '\n');
  });

  _dlqWorkers.set(tenantId, worker);
  logger.info(`DLQ worker started — consuming ${dlqName}`);
  return worker;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
// Start a DLQ worker for every tenant listed in AEGIS_TENANTS (comma-separated).
// Defaults to the single "default" tenant for single-tenant deployments.
// Example: AEGIS_TENANTS=acme,org_xyz,staging
//
// Workers for new tenants can also be started at runtime by calling
// getDlqWorker(tenantId) directly — e.g. from a tenant-registration webhook.

const TENANTS = (process.env.AEGIS_TENANTS ?? DEFAULT_TENANT)
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

for (const tenant of TENANTS) {
  getDlqWorker(tenant);
  console.log(`[dlq-worker] Listening on aegis-dead-letter:${tenant}`);
}
