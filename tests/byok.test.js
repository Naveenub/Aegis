/**
 * tests/byok.test.js — engine/billing/byok.js
 * Entitlement, sealed storage, tamper/cross-tenant rejection, no silent fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One shared in-memory Redis for the module under test and the test body;
// ctor options (lazyConnect/offline queue off) are ignored so it is "connected".
vi.mock('ioredis', async () => {
  const Mock = (await import('ioredis-mock')).default;
  const shared = new Mock();
  return { default: function () { return shared; } };
});
const tier = vi.hoisted(() => ({ v: 'enterprise' }));
vi.mock('../engine/tenant-registry.js', () => ({ getTier: vi.fn(async () => tier.v) }));
const ctor = vi.hoisted(() => vi.fn());
vi.mock('@anthropic-ai/sdk', () => ({ default: function (opts) { ctor(opts); this.opts = opts; } }));

import IORedis from 'ioredis';
import { setByokKey, getByokClient, deleteByokKey, hasByok } from '../engine/billing/byok.js';

const KEY = 'sk-ant-api03-' + 'a'.repeat(40);

beforeEach(async () => {
  process.env.AEGIS_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
  tier.v = 'enterprise';
  ctor.mockClear();
  await new IORedis().flushall();
  await deleteByokKey('acme');
});

describe('byok', () => {
  it('rejects non-enterprise tiers and malformed keys', async () => {
    tier.v = 'pro';
    await expect(setByokKey('acme', KEY)).rejects.toMatchObject({ code: 'BYOK_NOT_ENTITLED' });
    tier.v = 'enterprise';
    await expect(setByokKey('acme', 'nope')).rejects.toMatchObject({ code: 'BYOK_INVALID_KEY' });
  });

  it('stores sealed (never plaintext) and builds a client on the tenant key with no SDK retries', async () => {
    await setByokKey('acme', KEY);
    expect(await new IORedis().get('aegis:tenant:byok:acme')).not.toContain(KEY);
    const c = await getByokClient('acme');
    expect(c.opts).toMatchObject({ apiKey: KEY, maxRetries: 0 });
    await getByokClient('acme');
    expect(ctor).toHaveBeenCalledTimes(1); // cached
  });

  it('returns null with no key, or after downgrade; null again after delete', async () => {
    expect(await getByokClient('acme')).toBeNull();
    await setByokKey('acme', KEY);
    tier.v = 'pro';
    expect(await getByokClient('acme')).toBeNull();
    expect(await hasByok('acme')).toBe(false);
    tier.v = 'enterprise';
    await deleteByokKey('acme');
    expect(await getByokClient('acme')).toBeNull();
  });

  it('a blob copied to another tenant fails — throws, never falls back to platform', async () => {
    await setByokKey('acme', KEY);
    const r = new IORedis();
    await r.set('aegis:tenant:byok:evil', await r.get('aegis:tenant:byok:acme'));
    await expect(getByokClient('evil')).rejects.toThrow();
  });
});
