import IORedis from 'ioredis';

const redis = new IORedis();

const WORKFLOW_PREFIX = 'aegis:workflow:';
const META_PREFIX = 'aegis:workflow:meta:';

// ─── Control status values ────────────────────────────────────────────────────
// running | paused | cancelled | completed | failed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 🆕 Create workflow
 * @param {string} workflowId
 * @param {object[]} steps
 * @param {object} opts
 * @param {number} [opts.timeoutMs]   - wall-clock timeout for the whole workflow
 * @param {number} [opts.priority]    - 0=CRITICAL 1=HIGH 5=NORMAL 10=LOW
 */
export async function createWorkflow(workflowId, steps, opts = {}) {
  const key = WORKFLOW_PREFIX + workflowId;
  const metaKey = META_PREFIX + workflowId;

  const pipeline = redis.pipeline();

  for (const step of steps) {
    pipeline.hset(
      key,
      step.id,
      JSON.stringify({
        ...step,
        status: 'pending'
      })
    );
  }

  pipeline.set(
    metaKey,
    JSON.stringify({
      id: workflowId,
      status: 'running',
      priority: opts.priority ?? 5,
      timeoutMs: opts.timeoutMs ?? null,
      startedAt: Date.now(),
      createdAt: Date.now()
    })
  );

  await pipeline.exec();
}

/**
 * 🔄 Update step status
 */
export async function updateStep(workflowId, stepId, status) {
  const key = WORKFLOW_PREFIX + workflowId;

  const stepRaw = await redis.hget(key, stepId);
  if (!stepRaw) return;

  const step = JSON.parse(stepRaw);
  step.status = status;
  step.updatedAt = Date.now();

  await redis.hset(key, stepId, JSON.stringify(step));
}

/**
 * 📊 Get full workflow
 */
export async function getWorkflow(workflowId) {
  const key = WORKFLOW_PREFIX + workflowId;
  const metaKey = META_PREFIX + workflowId;

  const [stepsRaw, metaRaw] = await Promise.all([
    redis.hgetall(key),
    redis.get(metaKey)
  ]);

  if (!metaRaw) return null;

  const steps = Object.values(stepsRaw).map(JSON.parse);
  const meta = JSON.parse(metaRaw);

  return {
    ...meta,
    steps
  };
}

/**
 * 🔍 Get runnable steps (dependency-aware)
 */
export async function getRunnableSteps(workflowId) {
  const key = WORKFLOW_PREFIX + workflowId;

  const stepsRaw = await redis.hgetall(key);
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
 * ❌ Mark entire workflow failed (optional helper)
 */
export async function failWorkflow(workflowId, reason) {
  const metaKey = META_PREFIX + workflowId;

  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return;

  const meta = JSON.parse(metaRaw);
  meta.status = 'failed';
  meta.reason = reason;
  meta.failedAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));
}

/**
 * ⏸ Pause a running workflow.
 * In-flight steps finish their current attempt; no new steps are scheduled.
 */
export async function pauseWorkflow(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (meta.status !== 'running') return false;

  meta.status = 'paused';
  meta.pausedAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));
  return true;
}

/**
 * ▶️ Resume a paused workflow.
 * Caller is responsible for re-scheduling runnable steps after this.
 */
export async function resumeWorkflow(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (meta.status !== 'paused') return false;

  meta.status = 'running';
  meta.resumedAt = Date.now();
  delete meta.pausedAt;

  await redis.set(metaKey, JSON.stringify(meta));
  return true;
}

/**
 * 🛑 Cancel a workflow.
 * Running steps detect this at their next control-check and abort.
 * No new steps are scheduled.
 */
export async function cancelWorkflow(workflowId, reason = 'user request') {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (meta.status === 'cancelled' || meta.status === 'completed') return false;

  meta.status = 'cancelled';
  meta.cancelReason = reason;
  meta.cancelledAt = Date.now();

  await redis.set(metaKey, JSON.stringify(meta));
  return true;
}

/**
 * 📋 Get workflow control status (running | paused | cancelled | completed | failed)
 */
export async function getWorkflowStatus(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return null;
  return JSON.parse(metaRaw).status ?? null;
}

/**
 * ⏱ Check if workflow has exceeded its configured timeoutMs.
 * Returns true if timed out, false otherwise.
 */
export async function isWorkflowTimedOut(workflowId) {
  const metaKey = META_PREFIX + workflowId;
  const metaRaw = await redis.get(metaKey);
  if (!metaRaw) return false;

  const meta = JSON.parse(metaRaw);
  if (!meta.timeoutMs) return false;

  return Date.now() - meta.startedAt > meta.timeoutMs;
}
