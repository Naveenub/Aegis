import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis();

// ─── Tenant-scoped key helpers ────────────────────────────────────────────────
// All keys are prefixed with "aegis:{tenantId}:" so two tenants never share
// the same Redis keyspace even when running on the same instance.

function workflowKey(tenantId, workflowId) {
  return `aegis:${tenantId}:workflow:${workflowId}`;
}

function metaKey(tenantId, workflowId) {
  return `aegis:${tenantId}:workflow:meta:${workflowId}`;
}

function reviewKey(tenantId, workflowId, stepId) {
  return `aegis:${tenantId}:review:${workflowId}:${stepId}`;
}

function reviewIndexKey(tenantId) {
  return `aegis:${tenantId}:review:index`;
}

// ─── Control status values ────────────────────────────────────────────────────
// running | paused | cancelled | completed | failed | needs-review
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🆕 Create workflow
 */
export async function createWorkflow(workflowId, steps, opts = {}) {
  const tenantId = assertTenantId(opts.tenantId ?? DEFAULT_TENANT);
  const wKey = workflowKey(tenantId, workflowId);
  const mKey = metaKey(tenantId, workflowId);

  const pipeline = redis.pipeline();

  for (const step of steps) {
    pipeline.hset(wKey, step.id, JSON.stringify({ ...step, status: 'pending' }));
  }

  pipeline.set(mKey, JSON.stringify({
    id: workflowId,
    tenantId,
    status: 'running',
    priority: opts.priority ?? 5,
    timeoutMs: opts.timeoutMs ?? null,
    startedAt: Date.now(),
    createdAt: Date.now()
  }));

  await pipeline.exec();
}

/**
 * 🔄 Update step status
 */
export async function updateStep(workflowId, stepId, status, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const wKey = workflowKey(tenantId, workflowId);

  const stepRaw = await redis.hget(wKey, stepId);
  if (!stepRaw) return;

  const step = JSON.parse(stepRaw);
  step.status = status;
  step.updatedAt = Date.now();

  await redis.hset(wKey, stepId, JSON.stringify(step));
}

/**
 * 📊 Get full workflow
 */
export async function getWorkflow(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const wKey = workflowKey(tenantId, workflowId);
  const mKey = metaKey(tenantId, workflowId);

  const [stepsRaw, mRaw] = await Promise.all([
    redis.hgetall(wKey),
    redis.get(mKey)
  ]);

  if (!mRaw) return null;

  const steps = Object.values(stepsRaw).map(JSON.parse);
  const meta  = JSON.parse(mRaw);

  return { ...meta, steps };
}

/**
 * 🔍 Get runnable steps (dependency-aware)
 */
export async function getRunnableSteps(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const wKey = workflowKey(tenantId, workflowId);

  const stepsRaw = await redis.hgetall(wKey);
  const steps = Object.values(stepsRaw).map(JSON.parse);

  return steps.filter(step => {
    if (step.status !== 'pending') return false;
    if (!step.dependsOn || step.dependsOn.length === 0) return true;
    return step.dependsOn.every(dep => {
      const depStep = steps.find(s => s.id === dep);
      return depStep && depStep.status === 'completed';
    });
  });
}

/**
 * ❌ Mark entire workflow failed
 */
export async function failWorkflow(workflowId, reason, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const mKey = metaKey(tenantId, workflowId);

  const mRaw = await redis.get(mKey);
  if (!mRaw) return;

  const meta = JSON.parse(mRaw);
  meta.status = 'failed';
  meta.reason = reason;
  meta.failedAt = Date.now();

  await redis.set(mKey, JSON.stringify(meta));
}

/**
 * ⏸ Pause a running workflow.
 */
export async function pauseWorkflow(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const mKey = metaKey(tenantId, workflowId);
  const mRaw = await redis.get(mKey);
  if (!mRaw) return false;

  const meta = JSON.parse(mRaw);
  if (meta.status !== 'running') return false;

  meta.status = 'paused';
  meta.pausedAt = Date.now();

  await redis.set(mKey, JSON.stringify(meta));
  return true;
}

/**
 * ▶️ Resume a paused workflow.
 */
export async function resumeWorkflow(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const mKey = metaKey(tenantId, workflowId);
  const mRaw = await redis.get(mKey);
  if (!mRaw) return false;

  const meta = JSON.parse(mRaw);
  if (meta.status !== 'paused') return false;

  meta.status = 'running';
  meta.resumedAt = Date.now();
  delete meta.pausedAt;

  await redis.set(mKey, JSON.stringify(meta));
  return true;
}

/**
 * 🛑 Cancel a workflow.
 */
export async function cancelWorkflow(workflowId, reason = 'user request', tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const mKey = metaKey(tenantId, workflowId);
  const mRaw = await redis.get(mKey);
  if (!mRaw) return false;

  const meta = JSON.parse(mRaw);
  if (meta.status === 'cancelled' || meta.status === 'completed') return false;

  meta.status = 'cancelled';
  meta.cancelReason = reason;
  meta.cancelledAt = Date.now();

  await redis.set(mKey, JSON.stringify(meta));
  return true;
}

/**
 * 📋 Get workflow control status
 */
export async function getWorkflowStatus(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const mKey = metaKey(tenantId, workflowId);
  const mRaw = await redis.get(mKey);
  if (!mRaw) return null;
  return JSON.parse(mRaw).status ?? null;
}

/**
 * ⏱ Check if workflow has exceeded its configured timeoutMs.
 */
export async function isWorkflowTimedOut(workflowId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const mKey = metaKey(tenantId, workflowId);
  const mRaw = await redis.get(mKey);
  if (!mRaw) return false;

  const meta = JSON.parse(mRaw);
  if (!meta.timeoutMs) return false;

  return Date.now() - meta.startedAt > meta.timeoutMs;
}

// ─── Human-in-the-loop review queue ──────────────────────────────────────────

/**
 * 🚩 Flag a step for human review.
 */
export async function flagForReview(workflowId, stepId, details = {}) {
  const tenantId = assertTenantId(details.tenantId ?? DEFAULT_TENANT);
  const rKey  = reviewKey(tenantId, workflowId, stepId);
  const riKey = reviewIndexKey(tenantId);

  const record = {
    workflowId,
    stepId,
    tenantId,
    status: 'pending',
    ...details,
    flaggedAt: details.flaggedAt ?? Date.now()
  };

  const pipeline = redis.pipeline();
  pipeline.set(rKey, JSON.stringify(record));
  pipeline.zadd(riKey, record.flaggedAt, rKey);
  await pipeline.exec();

  return record;
}

/**
 * 📋 Get all items currently pending human review, newest first.
 */
export async function getReviewQueue({ limit = 50, status = 'pending', tenantId = DEFAULT_TENANT } = {}) {
  assertTenantId(tenantId);
  const riKey = reviewIndexKey(tenantId);

  const keys = await redis.zrevrange(riKey, 0, limit - 1);
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
 */
export async function resolveReview(workflowId, stepId, resolution, note = '', tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const rKey = reviewKey(tenantId, workflowId, stepId);

  const raw = await redis.get(rKey);
  if (!raw) return false;

  const record = JSON.parse(raw);
  record.status     = resolution;
  record.resolvedAt = Date.now();
  record.note       = note;

  await redis.set(rKey, JSON.stringify(record));
  return record;
}