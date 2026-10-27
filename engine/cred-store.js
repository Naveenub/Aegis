/**
 * engine/cred-store.js — Encrypted per-tenant OAuth credentials
 *
 * Kept apart from repo-store.js on purpose: that module holds metadata only and
 * its hash is read wholesale into `cfg`. Secrets live here, sealed with
 * token-vault.js, under a separate key.
 *
 * Redis layout:
 *   aegis:tenant:repo-cred:{tenantId}   String  sealed JSON
 *                                               { provider, accessToken, refreshToken, expiresAt }
 *   aegis:cred-lock:{tenantId}          String  lock token (refresh mutual exclusion)
 *
 * GitLab rotates refresh tokens (each is single-use), so two workers refreshing
 * at once would invalidate each other. withCredLock serialises refreshes.
 */

import IORedis from 'ioredis';
import { randomBytes } from 'crypto';
import { assertTenantId } from './tenant.js';
import { seal, open } from './token-vault.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

const CRED_KEY = (t) => `aegis:tenant:repo-cred:${t}`;
const LOCK_KEY = (t) => `aegis:cred-lock:${t}`;
const aad = (tenantId, provider) => `${tenantId}:${provider}`;

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** @param {{ accessToken: string, refreshToken?: string, expiresAt: number }} creds */
export async function saveCreds(tenantId, provider, creds) {
  assertTenantId(tenantId);
  await redis.set(CRED_KEY(tenantId), seal(JSON.stringify({ provider, ...creds }), aad(tenantId, provider)));
}

/** @returns {Promise<{ accessToken, refreshToken, expiresAt } | null>} null when absent, wrong provider, or undecryptable */
export async function loadCreds(tenantId, provider) {
  assertTenantId(tenantId);
  const sealed = await redis.get(CRED_KEY(tenantId));
  if (!sealed) return null;
  try {
    const c = JSON.parse(open(sealed, aad(tenantId, provider)));
    return c.provider === provider ? c : null;
  } catch {
    return null; // wrong key / tampered / other provider — treat as not connected
  }
}

export async function deleteCreds(tenantId) {
  assertTenantId(tenantId);
  await redis.del(CRED_KEY(tenantId));
}

export async function withCredLock(tenantId, fn, { ttlMs = 30_000, waitMs = 30_000 } = {}) {
  assertTenantId(tenantId);
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + waitMs;
  while (!(await redis.set(LOCK_KEY(tenantId), token, 'PX', ttlMs, 'NX'))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for credential lock (${tenantId}).`);
    await new Promise(r => setTimeout(r, 200));
  }
  try {
    return await fn();
  } finally {
    try { await redis.eval(RELEASE_LUA, 1, LOCK_KEY(tenantId), token); } catch { /* expired */ }
  }
}
