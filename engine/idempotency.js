import IORedis from 'ioredis';
import crypto from 'crypto';

const redis = new IORedis();
const PREFIX = 'aegis:idem:';

/**
 * Generate operation ID
 */
export function getOperationId(workflowId, stepId, patch) {
  return crypto
    .createHash('sha256')
    .update(workflowId + stepId + patch)
    .digest('hex');
}

/**
 * Check if already applied
 */
export async function isApplied(opId) {
  return await redis.exists(PREFIX + opId);
}

/**
 * Mark as applied
 */
export async function markApplied(opId) {
  await redis.set(PREFIX + opId, '1');
}
