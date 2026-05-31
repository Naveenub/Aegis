/**
 * engine/key-store.js
 *
 * Runtime API key management — rotation and revocation without restarts.
 *
 * Problem solved
 * ──────────────
 * The original auth.js read keys from process.env at boot.  Rotating a key
 * meant editing .env and restarting every process.  There was no way to
 * revoke a compromised key without downtime.
 *
 * Design
 * ──────
 * Keys are stored in Redis, not plaintext.  Only a SHA-256 hash of the raw
 * key is persisted.  The raw value is returned exactly once — at creation —
 * and is never stored.  auth.js hashes the incoming request key and compares
 * against the stored hash (same principle as bcrypt but faster, appropriate
 * for high-entropy random secrets).
 *
 * Redis key layout
 * ────────────────
 *   aegis:keys:{tenantId}          – Hash: keyId → JSON(KeyRecord)
 *   aegis:key-index:{hash}         – String: tenantId (reverse lookup)
 *
 * KeyRecord shape (stored per keyId)
 * ───────────────────────────────────
 *   {
 *     keyId:     string,   // short stable identifier, e.g. "k_a1b2c3d4"
 *     hash:      string,   // hex SHA-256 of the raw key
 *     tenantId:  string,
 *     label:     string,   // human-readable note ("prod rotation 2026-05")
 *     createdAt: number,   // ms epoch
 *     expiresAt: number|null,  // ms epoch, null = never
 *     revokedAt: number|null,  // ms epoch, null = active
 *   }
 *
 * A tenant can have multiple active keys simultaneously to support zero-
 * downtime rotation:
 *   1. Create new key  → distribute to services
 *   2. Revoke old key  → old key is dead instantly, no restart needed
 *
 * Env-var fallback
 * ────────────────
 * auth.js continues to honour AEGIS_API_KEY_{TENANTID} so existing deployments
 * keep working.  Redis keys take precedence when both are present so operators
 * can migrate tenant by tenant.
 */

import { createHash, randomBytes } from 'crypto';
import IORedis from 'ioredis';
import { assertTenantId } from './tenant.js';

const redis = new IORedis();

// ─── Redis key helpers ────────────────────────────────────────────────────────

const TENANT_KEYS_KEY = (tenantId) => `aegis:keys:${tenantId}`;
const KEY_INDEX_KEY   = (hash)     => `aegis:key-index:${hash}`;

// ─── Crypto helpers ───────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random API key.
 * Format: "aegk_<40 hex chars>"  (prefix makes keys grep-able in logs/secrets scanners)
 */
function generateRawKey() {
  return `aegk_${randomBytes(20).toString('hex')}`;
}

/**
 * SHA-256 hash of a raw key (hex string).
 * Used for both storage and lookup — we never store or compare plaintext.
 */
export function hashKey(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

// ─── Write operations ─────────────────────────────────────────────────────────

/**
 * Create a new API key for a tenant.
 *
 * @param {string} tenantId
 * @param {object} [opts]
 * @param {string}      [opts.label]     - human-readable note (e.g. "prod deploy 2026-05")
 * @param {number|null} [opts.expiresAt] - ms epoch; null = never expires
 * @returns {Promise<{ keyId: string, rawKey: string, record: KeyRecord }>}
 *   rawKey is returned ONCE and never stored — the caller must distribute it.
 */
export async function createKey(tenantId, { label = '', expiresAt = null } = {}) {
  assertTenantId(tenantId);

  const rawKey  = generateRawKey();
  const hash    = hashKey(rawKey);
  const keyId   = `k_${randomBytes(4).toString('hex')}`;

  const record = {
    keyId,
    hash,
    tenantId,
    label:     label || `key created ${new Date().toISOString()}`,
    createdAt: Date.now(),
    expiresAt: expiresAt ?? null,
    revokedAt: null,
  };

  const pipeline = redis.pipeline();
  // Store record in the per-tenant hash
  pipeline.hset(TENANT_KEYS_KEY(tenantId), keyId, JSON.stringify(record));
  // Store reverse-lookup hash → tenantId so auth.js can find the tenant for
  // any valid key without scanning all tenants.
  pipeline.set(KEY_INDEX_KEY(hash), tenantId);

  await pipeline.exec();

  // Return rawKey exactly once — never retrievable again.
  return { keyId, rawKey, record };
}

/**
 * Revoke a key immediately.
 * Marks revokedAt in the record AND removes the reverse-index so auth.js
 * will reject it on the very next request (no cache, no grace period).
 *
 * @param {string} tenantId
 * @param {string} keyId
 * @returns {Promise<boolean>}  true if found and revoked, false if not found
 */
export async function revokeKey(tenantId, keyId) {
  assertTenantId(tenantId);

  const raw = await redis.hget(TENANT_KEYS_KEY(tenantId), keyId);
  if (!raw) return false;

  const record = JSON.parse(raw);

  // Remove the reverse-index first — auth starts rejecting immediately
  await redis.del(KEY_INDEX_KEY(record.hash));

  // Tombstone the record (keep for audit log; do not delete from hash)
  record.revokedAt = Date.now();
  await redis.hset(TENANT_KEYS_KEY(tenantId), keyId, JSON.stringify(record));

  return true;
}

// ─── Read operations ──────────────────────────────────────────────────────────

/**
 * List all keys for a tenant (never returns the raw key or hash).
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>}  array of sanitised KeyRecords (no hash field)
 */
export async function listKeys(tenantId) {
  assertTenantId(tenantId);

  const raw = await redis.hgetall(TENANT_KEYS_KEY(tenantId));
  if (!raw) return [];

  return Object.values(raw)
    .map(v => {
      const r = JSON.parse(v);
      const { hash: _omit, ...safe } = r; // never expose hash
      return safe;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Look up a tenant by the hash of an incoming raw key.
 * Used by auth.js as the primary key-resolution path.
 *
 * Returns null when:
 *   - hash is not in the index (unknown key)
 *   - key is revoked (revokedAt is set)
 *   - key is expired (expiresAt < now)
 *
 * @param {string} hash  - hex SHA-256 of the raw key from the request
 * @returns {Promise<{ tenantId: string, keyId: string }|null>}
 */
export async function lookupByHash(hash) {
  const tenantId = await redis.get(KEY_INDEX_KEY(hash));
  if (!tenantId) return null;

  // Fetch the full record to check revocation and expiry
  const allRaw = await redis.hgetall(TENANT_KEYS_KEY(tenantId));
  if (!allRaw) return null;

  for (const raw of Object.values(allRaw)) {
    const record = JSON.parse(raw);

    if (record.hash !== hash)    continue; // not this key
    if (record.revokedAt)        return null; // revoked
    if (record.expiresAt && Date.now() > record.expiresAt) {
      // Expired — clean up the index lazily
      await redis.del(KEY_INDEX_KEY(hash));
      return null;
    }

    return { tenantId: record.tenantId, keyId: record.keyId };
  }

  return null;
}
