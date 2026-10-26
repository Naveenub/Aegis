#!/usr/bin/env node
/**
 * scripts/cleanup-pending.js
 *
 * Removes self-serve signups that never paid (see
 * engine/billing/pending-cleanup.js). Run daily — cron or the k8s CronJob.
 *
 *   npm run billing:cleanup                  # default: pending > 48h
 *   node scripts/cleanup-pending.js --hours=72 --dry-run
 */
import dotenv from 'dotenv';
import { cleanupPendingTenants } from '../engine/billing/pending-cleanup.js';

dotenv.config();

const dryRun = process.argv.includes('--dry-run');
const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
const maxAgeHours = hoursArg ? Number(hoursArg.split('=')[1]) : 48;
if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
  console.error('[cleanup-pending] --hours must be a positive number.');
  process.exit(2);
}

const r = await cleanupPendingTenants({ maxAgeHours, dryRun });
console.log(
  `[cleanup-pending]${dryRun ? ' (dry-run)' : ''} removed=${r.removed.length} reconciled=${r.reconciled.length} failed=${r.failed.length} kept=${r.kept}`
);
if (r.removed.length) console.log(`[cleanup-pending] removed: ${r.removed.join(', ')}`);
if (r.reconciled.length) console.log(`[cleanup-pending] reconciled to active: ${r.reconciled.join(', ')}`);
process.exit(r.failed.length > 0 ? 1 : 0);
