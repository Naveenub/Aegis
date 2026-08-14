import IORedis from 'ioredis';
import Redlock from 'redlock';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
// Without a listener, ioredis logs an unhandled 'error' event for every
// connection failure. Rejections already surface per-command to callers,
// so this listener only silences that duplicate console noise.
redis.on('error', () => {});

const redlock = new Redlock(
  [redis],
  { retryCount: 5, retryDelay: 200, retryJitter: 100 }
);

/**
 * 🔒 Acquire distributed lock — tenant-scoped so tenants can't block each other.
 */
export async function acquireLock(file, tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  const resource = `locks:${tenantId}:${file}`;
  return redlock.acquire([resource], 10000); // 10s TTL
}

/**
 * 🔓 Release lock
 */
export async function releaseLock(lock) {
  try {
    await lock.release();
  } catch {
    // lock might already be released / expired
  }
}