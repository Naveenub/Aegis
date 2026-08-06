import IORedis from 'ioredis';
import crypto from 'crypto';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined);

// How long an idempotency key is retained before Redis expires it.
// Default: 7 days. Override with AEGIS_IDEM_TTL_SECONDS in your environment.
const IDEM_TTL_SECONDS = parseInt(process.env.AEGIS_IDEM_TTL_SECONDS ?? '', 10) || 60 * 60 * 24 * 7;

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
 * Mark as applied (tenant-scoped).
 * Key expires after AEGIS_IDEM_TTL_SECONDS (default 7 days) so the Redis
 * keyspace stays bounded even in long-running deployments.
 */
export async function markApplied(opId, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  await redis.set(idemPrefix(tenantId) + opId, '1', 'EX', IDEM_TTL_SECONDS);
}
