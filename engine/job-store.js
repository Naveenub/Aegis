import fs from 'fs';
import path from 'path';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

// Each tenant gets their own jobs.json so job lists never cross-pollinate.
function jobPath(tenantId) {
  const dir = path.join('.claude', 'context', 'tenants', tenantId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'jobs.json');
}

function load(tenantId) {
  const p = jobPath(tenantId);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p));
}

function save(data, tenantId) {
  fs.writeFileSync(jobPath(tenantId), JSON.stringify(data, null, 2));
}

export function createJob(jobId, step, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const data = load(tenantId);

  data.push({
    jobId,
    stepId: step.id,
    agent: step.agent,
    status: 'queued',
    result: null,
    retries: 0,
    tenantId,
    createdAt: new Date().toISOString()
  });

  save(data, tenantId);
}

export function updateJob(jobId, updates, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const data = load(tenantId);
  const job  = data.find(j => j.jobId === jobId);
  if (!job) return;

  Object.assign(job, updates, { updatedAt: new Date().toISOString() });
  save(data, tenantId);
}

export function incrementRetries(jobId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const data = load(tenantId);
  const job  = data.find(j => j.jobId === jobId);

  if (job) {
    job.retries += 1;
    save(data, tenantId);
  }
}

export function listJobs(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  return load(tenantId);
}