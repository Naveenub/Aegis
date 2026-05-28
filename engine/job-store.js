/**
 * job-store.js — per-tenant job state store
 *
 * FIX: The original code did an unguarded load→mutate→save on a flat JSON file.
 * Under concurrent BullMQ workers this is a classic read-modify-write race:
 * two workers read the same stale snapshot, both write their update, and the
 * last writer silently overwrites the other's change — corrupting jobs.json.
 *
 * Solution: wrap every mutation in a retry loop using `proper-lockfile`, which
 * creates an advisory `.lock` file next to jobs.json. If another process
 * already holds the lock the call retries (up to LOCK_RETRIES times) so no
 * update is ever lost. Reads (listJobs) intentionally skip the lock —
 * an eventually-consistent snapshot is fine for the dashboard/CLI.
 */

import fs   from 'fs';
import path from 'path';
import lock from 'proper-lockfile';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const LOCK_OPTS = {
  retries : { retries: 10, minTimeout: 50, maxTimeout: 200, factor: 1.5 },
  stale   : 15_000,   // treat a lock as stale after 15 s (crashed worker)
};

// ─── internal helpers ─────────────────────────────────────────────────────────

function jobPath(tenantId) {
  const dir = path.join('.claude', 'context', 'tenants', tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'jobs.json');
}

function ensureFile(tenantId) {
  const p = jobPath(tenantId);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
  return p;
}

function load(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

function save(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/**
 * Acquire an exclusive advisory lock on jobs.json for this tenant,
 * run `fn(data)` which mutates the in-memory array, flush to disk,
 * then release.  Any exception inside `fn` releases the lock before
 * propagating so the process never dead-locks itself.
 */
async function withLock(tenantId, fn) {
  const p       = ensureFile(tenantId);
  const release = await lock.lock(p, LOCK_OPTS);
  try {
    const data    = load(p);
    const updated = fn(data);
    save(p, updated);
  } finally {
    await release();
  }
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function createJob(jobId, step, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await withLock(tenantId, data => {
    data.push({
      jobId,
      stepId   : step.id,
      agent    : step.agent,
      status   : 'queued',
      result   : null,
      retries  : 0,
      tenantId,
      createdAt: new Date().toISOString(),
    });
    return data;
  });
}

export async function updateJob(jobId, updates, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await withLock(tenantId, data => {
    const job = data.find(j => j.jobId === jobId);
    if (job) Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    return data;
  });
}

export async function incrementRetries(jobId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await withLock(tenantId, data => {
    const job = data.find(j => j.jobId === jobId);
    if (job) job.retries += 1;
    return data;
  });
}

// read — lock-free (eventual consistency is fine for CLI/dashboard)
export function listJobs(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  return load(ensureFile(tenantId));
}
