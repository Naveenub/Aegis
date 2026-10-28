/**
 * engine/billing/byok.js — Bring-your-own Anthropic key (enterprise option)
 *
 * A tenant with a BYOK key is billed by Anthropic directly: its calls skip the
 * platform spend cap and are not metered to Stripe as tokens_in/tokens_out.
 *
 *   - Key is sealed with token-vault.js (AES-256-GCM, AAD = `${tenantId}:anthropic`);
 *     a Redis dump or a blob copied to another tenant yields nothing.
 *   - Only tiers with `spend.byok === true` (tiers.js) can use it. A downgraded
 *     tenant silently stops resolving a client.
 *   - NO FALLBACK: if the tenant's key fails (revoked, out of credit) the call
 *     fails. It never retries on the platform key.
 *
 * Redis: aegis:tenant:byok:{tenantId}  String  sealed key
 */

import IORedis from 'ioredis';
import Anthropic from '@anthropic-ai/sdk';
import { assertTenantId } from '../tenant.js';
import { seal, open } from '../token-vault.js';
import { getTier } from '../tenant-registry.js';
import { getTierConfig } from './tiers.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

const BYOK_KEY = (t) => `aegis:tenant:byok:${t}`;
const aad = (t) => `${t}:anthropic`;

// tenantId -> { sealed, client }. Keyed on the sealed blob so rotation/removal
// invalidates the cached client on the next call without a TTL.
const cache = new Map();

export async function tierAllowsByok(tenantId) {
  return getTierConfig(await getTier(tenantId)).spend?.byok === true;
}

/** @throws if the tier is not entitled or the key is malformed */
export async function setByokKey(tenantId, apiKey) {
  assertTenantId(tenantId);
  if (!(await tierAllowsByok(tenantId))) {
    const err = new Error('BYOK is an enterprise-tier option.');
    err.code = 'BYOK_NOT_ENTITLED';
    throw err;
  }
  const key = String(apiKey ?? '').trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    const err = new Error('Not a valid Anthropic API key.');
    err.code = 'BYOK_INVALID_KEY';
    throw err;
  }
  await redis.set(BYOK_KEY(tenantId), seal(key, aad(tenantId)));
  cache.delete(tenantId);
}

export async function deleteByokKey(tenantId) {
  assertTenantId(tenantId);
  await redis.del(BYOK_KEY(tenantId));
  cache.delete(tenantId);
}

export async function hasByok(tenantId) {
  assertTenantId(tenantId);
  return (await redis.exists(BYOK_KEY(tenantId))) === 1 && (await tierAllowsByok(tenantId));
}

/**
 * @returns {Promise<Anthropic|null>} client on the tenant's own key, or null
 *   (no key stored, or tier not entitled) → caller uses the platform path.
 *   Throws if a key is stored but cannot be decrypted: never degrade silently
 *   onto the platform key.
 */
export async function getByokClient(tenantId) {
  assertTenantId(tenantId);
  const sealed = await redis.get(BYOK_KEY(tenantId));
  if (!sealed) { cache.delete(tenantId); return null; }
  if (!(await tierAllowsByok(tenantId))) return null;

  const hit = cache.get(tenantId);
  if (hit && hit.sealed === sealed) return hit.client;

  const apiKey = open(sealed, aad(tenantId)); // throws on tamper / wrong vault key
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 300_000 });
  cache.set(tenantId, { sealed, client });
  return client;
}
