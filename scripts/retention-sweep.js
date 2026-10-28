#!/usr/bin/env node
/**
 * scripts/retention-sweep.js
 *
 * Enforces each tenant's data-retention policy (engine/retention.js). Run
 * daily — cron or the k8s CronJob.
 *
 *   npm run retention:sweep
 *   node scripts/retention-sweep.js --dry-run
 *   node scripts/retention-sweep.js --tenant=acme
 */
import dotenv from 'dotenv';
import { runRetentionSweep } from '../engine/retention.js';
import { logger } from '../engine/logger.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
const tenantIds = tenantArg ? [tenantArg.split('=')[1]] : undefined;

// Engine Redis clients use lazyConnect with the offline queue disabled (fail fast
// in the API), so in a short-lived script the first command on each client is
// rejected while its connection is still opening. The sweep is idempotent, so
// retry a few times until every client is warm.
const COLD = /Stream isn't writeable/;
let r;
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    r = await runRetentionSweep({ dryRun, tenantIds });
    if (!r.errors.some((e) => COLD.test(e.error))) break;
  } catch (err) {
    if (!COLD.test(err.message) || attempt === 4) throw err;
  }
  await new Promise((res) => setTimeout(res, 750));
}

for (const [t, c] of Object.entries(r.tenants)) {
  console.log(
    `[retention-sweep]${dryRun ? ' (dry-run)' : ''} tenant=${t} jobs=${c.jobs} workflows_purged=${c.workflowsPurged} ` +
    `workflows_scrubbed=${c.workflowsScrubbed} memory=${c.memory}`
  );
}
for (const e of r.errors) logger.error({ scope: e.scope }, `[retention-sweep] ${e.error}`);
process.exit(r.errors.length > 0 ? 1 : 0);
