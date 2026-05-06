import IORedis from 'ioredis';

const redis = new IORedis();

const WORKFLOW_PREFIX = 'aegis:workflow:';
const META_PREFIX = 'aegis:workflow:meta:';

/**
 * 🆕 Create workflow
 */
export async function createWorkflow(workflowId, steps) {
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
