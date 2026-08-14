/**
 * Tenant Registry
 *
 * Persists the set of known tenants in Redis so registrations survive process
 * restarts.  The AEGIS_TENANTS env var still seeds tenants at boot (backwards
 * compatible); any tenant added via POST /tenants is merged into the same set.
 *
 * Redis key layout:
 *   aegis:tenants           – Redis Set of all registered tenantIds
 *   aegis:tenant:meta:{id}  – Hash of metadata (createdAt, label, …)
 */

import IORedis from 'ioredis';
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

const TENANTS_SET_KEY  = 'aegis:tenants';
const TENANT_META_KEY  = (id) => `aegis:tenant:meta:${id}`;

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Return all registered tenantIds.
 * @returns {Promise<string[]>}
 */
export async function listTenants() {
  const members = await redis.smembers(TENANTS_SET_KEY);
  return members.sort();
}

/**
 * Return metadata for a single tenant, or null if not registered.
 * @param {string} tenantId
 * @returns {Promise<object|null>}
 */
export async function getTenant(tenantId) {
  assertTenantId(tenantId);
  const isMember = await redis.sismember(TENANTS_SET_KEY, tenantId);
  if (!isMember) return null;
  const meta = await redis.hgetall(TENANT_META_KEY(tenantId));
  return { tenantId, ...meta };
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Register a tenant.  Idempotent — calling it twice for the same id is safe.
 *
 * @param {string} tenantId   – must pass assertTenantId()
 * @param {object} [meta]     – optional { label } stored alongside the id
 * @returns {Promise<{ tenantId, created: boolean }>}
 *   created=false when the tenant already existed
 */
export async function registerTenant(tenantId, meta = {}) {
  assertTenantId(tenantId);

  // SADD returns 1 if the member was new, 0 if it already existed
  const added = await redis.sadd(TENANTS_SET_KEY, tenantId);
  const created = added === 1;

  if (created) {
    await redis.hset(TENANT_META_KEY(tenantId), {
      createdAt: String(Date.now()),
      label: meta.label ?? tenantId,
    });
  }

  return { tenantId, created };
}

/**
 * Set the Stripe subscription-item mapping used to report metered usage for
 * this tenant. One subscription item per metered dimension (workflow_run,
 * agent_step, tokens, sandbox_minutes) — see billing/stripe-reporter.js.
 *
 * @param {string} tenantId
 * @param {Record<string,string>} stripeItems - eventType -> Stripe subscription item id
 */
export async function setBillingConfig(tenantId, stripeItems) {
  assertTenantId(tenantId);
  await redis.hset(TENANT_META_KEY(tenantId), { stripeItems: JSON.stringify(stripeItems) });
}

/**
 * Read the Stripe subscription-item mapping for a tenant.
 * @param {string} tenantId
 * @returns {Promise<Record<string,string>|null>}
 */
export async function getBillingConfig(tenantId) {
  assertTenantId(tenantId);
  const raw = await redis.hget(TENANT_META_KEY(tenantId), 'stripeItems');
  return raw ? JSON.parse(raw) : null;
}

/**
 * Set the pricing tier for a tenant. Validity of the tier name itself is
 * billing/tiers.js's concern (getTierConfig() falls back to DEFAULT_TIER for
 * unknown values) — this just persists whatever string is passed.
 *
 * @param {string} tenantId
 * @param {string} tier
 */
export async function setTier(tenantId, tier) {
  assertTenantId(tenantId);
  await redis.hset(TENANT_META_KEY(tenantId), { tier });
}

/**
 * Read a tenant's pricing tier. Returns null if never set (caller should
 * treat null as DEFAULT_TIER — see billing/tiers.js).
 *
 * @param {string} tenantId
 * @returns {Promise<string|null>}
 */
export async function getTier(tenantId) {
  assertTenantId(tenantId);
  const tier = await redis.hget(TENANT_META_KEY(tenantId), 'tier');
  return tier ?? null;
}

/**
 * Seed the registry from the AEGIS_TENANTS env var (and the default tenant)
 * at process start.  Called once during server / worker bootstrap.
 *
 * Workers must be started separately for any tenant that is new to *this*
 * process; this function only handles persistence.
 */
export async function seedTenantsFromEnv() {
  const envTenants = (process.env.AEGIS_TENANTS ?? DEFAULT_TENANT)
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);

  for (const id of envTenants) {
    try {
      await registerTenant(id);
    } catch (err) {
      // Invalid id in env var — log and skip rather than crashing the server
      console.warn(`[tenant-registry] Skipping invalid tenantId from env "${id}": ${err.message}`);
    }
  }
}
