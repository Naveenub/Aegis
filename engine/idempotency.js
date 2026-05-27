import IORedis from 'ioredis';
import crypto from 'crypto';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis();

// Tenant-scoped idempotency prefix prevents cross-tenant key collisions.
function idemPrefix(tenantId) {
  return `aegis:${tenantId}:idem:`;
}

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
 * Check if already applied (tenant-scoped)
 */
export async function isApplied(opId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  return await redis.exists(idemPrefix(tenantId) + opId);
}

/**
 * Mark as applied (tenant-scoped)
 */
export async function markApplied(opId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await redis.set(idemPrefix(tenantId) + opId, '1');
}