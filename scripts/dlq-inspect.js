/**
 * dlq-inspect.js
 *
 * CLI tool to inspect the dead-letter queue for a specific tenant.
 *
 * Usage:
 *   node scripts/dlq-inspect.js [tenantId]
 *
 * tenantId defaults to "default" (single-tenant deployments).
 *
 * Examples:
 *   node scripts/dlq-inspect.js
 *   node scripts/dlq-inspect.js acme
 *   node scripts/dlq-inspect.js org_xyz
 */

import { getDeadLetterQueue } from '../engine/queue.js';
import { DEFAULT_TENANT } from '../engine/tenant.js';

const tenantId = process.argv[2]?.trim() || DEFAULT_TENANT;

const dlq = getDeadLetterQueue(tenantId);
const jobs = await dlq.getJobs(['waiting', 'failed']);

if (jobs.length === 0) {
  console.info(`[dlq-inspect] No jobs in aegis-dead-letter:${tenantId}`);
  process.exit(0);
}

console.info(`[dlq-inspect] ${jobs.length} job(s) in aegis-dead-letter:${tenantId}\n`);

for (const job of jobs) {
  console.info({
    id: job.id,
    step: job.data.step?.description,
    error: job.data.error,
    attemptsExhausted: job.data.attemptsExhausted,
    workflowId: job.data.workflowId,
    tenantId
  });
}
