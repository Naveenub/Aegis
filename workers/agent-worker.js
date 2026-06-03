/**
 * workers/agent-worker.js — BullMQ worker bootstrap
 *
 * The worker factory (getWorker) and all job-processing logic live in
 * engine/git.js so they can be unit-tested without spawning real processes.
 * This file is the process entry point: it imports the factory, spins up one
 * worker per configured tenant, and logs startup status.
 */

import { getWorker } from '../engine/git.js';
import { DEFAULT_TENANT } from '../engine/tenant.js';
import { approvalModeActive } from '../engine/approval-gate.js';

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const TENANTS = (process.env.AEGIS_TENANTS ?? DEFAULT_TENANT)
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

for (const tenant of TENANTS) {
  getWorker(tenant);
  console.info(`[agent-worker] Listening on aegis-tasks:${tenant}`);
}

if (approvalModeActive) {
  console.info('[agent-worker] Approval gate ACTIVE — patches will be held for human review before apply');
}

export { getWorker };
