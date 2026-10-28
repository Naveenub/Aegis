/**
 * tests/spend-guard.test.js
 *
 * engine/billing/spend-guard.js against ioredis-mock (real Lua execution):
 * hard cap, atomic concurrent reserve, settle/release accounting, retry
 * bounding, unverified-first-invoice cap, prepaid credits, suspended tenant,
 * fail-closed on Redis error, idempotent top-up.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// One shared in-memory Redis for the module under test and the test body;
// ctor options (lazyConnect/offline queue off) are ignored so it is "connected".
vi.mock('ioredis', async () => {
  const Mock = (await import('ioredis-mock')).default;
  const shared = new Mock();
  return { default: function () { return shared; } };
});

const reg = vi.hoisted(() => ({
  tier: 'starter', status: 'active', cfg: { mode: null, capUsd: null }, firstPaid: null, customer: null,
}));
vi.mock('../engine/tenant-registry.js', () => ({
  getTier:             vi.fn(async () => reg.tier),
  getStatus:           vi.fn(async () => reg.status),
  getSpendConfig:      vi.fn(async () => reg.cfg),
  getFirstPaid:        vi.fn(async () => reg.firstPaid),
  getStripeCustomerId: vi.fn(async () => reg.customer),
}));
// $3 / $15 per Mtok, flat
vi.mock('../engine/metrics.js', () => ({
  computeCostUsd: (_m, i = 0, o = 0) => (i / 1e6) * 3 + (o / 1e6) * 15,
}));

import IORedis from 'ioredis';
import {
  reserveSpend, settleSpend, releaseSpend, addCredits, getSpendStatus, SpendGuardError, RESERVATION_TTL_MS,
} from '../engine/billing/spend-guard.js';

const call = (t = 'acme', over = {}) =>
  ({ tenantId: t, model: 'm', inputChars: 3_000, maxOutputTokens: 8192, ...over }); // ≈ $0.1259 reserve

beforeEach(async () => {
  await new IORedis().flushall();
  Object.assign(reg, { tier: 'starter', status: 'active', cfg: { mode: null, capUsd: null }, firstPaid: null, customer: null });
});

describe('capped mode', () => {
  it('blocks once spent + reserved would exceed the cap', async () => {
    reg.cfg = { mode: 'capped', capUsd: 0.3 };
    await reserveSpend(call()); await reserveSpend(call());          // 0.2518 reserved
    await expect(reserveSpend(call())).rejects.toMatchObject({ code: 'SPEND_CAP_REACHED' });
  });

  it('concurrent reservations cannot jointly overshoot (atomic)', async () => {
    reg.cfg = { mode: 'capped', capUsd: 1 };
    const r = await Promise.allSettled(Array.from({ length: 40 }, () => reserveSpend(call())));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(7); // floor(1 / 0.1259)
    const s = await getSpendStatus('acme');
    expect(s.spentUsd + s.reservedUsd).toBeLessThanOrEqual(1);
  });

  it('settle replaces the reservation with actual cost and frees headroom', async () => {
    reg.cfg = { mode: 'capped', capUsd: 0.2 };
    const r = await reserveSpend(call());
    await settleSpend(r, { model: 'm', inputTokens: 1000, outputTokens: 500 }); // $0.0105
    const s = await getSpendStatus('acme');
    expect(s.reservedUsd).toBe(0);
    expect(s.spentUsd).toBeCloseTo(0.0105, 6);
    await expect(reserveSpend(call())).resolves.toBeTruthy();
  });

  it('retries each reserve: a failing retry loop is bounded by the cap', async () => {
    reg.cfg = { mode: 'capped', capUsd: 0.5 };
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      try { const r = await reserveSpend(call()); await settleSpend(r, { model: 'm', inputTokens: 10_000, outputTokens: 8192 }); ok++; }
      catch (e) { expect(e.code).toBe('SPEND_CAP_REACHED'); break; }
    }
    expect(ok).toBeLessThan(5);
    expect((await getSpendStatus('acme')).spentUsd).toBeLessThanOrEqual(0.5 + 0.2);
  });

  it('API rejection releases in full; timeout keeps the input estimate', async () => {
    const a = await reserveSpend(call());
    await releaseSpend(a, Object.assign(new Error('429'), { name: 'RateLimitError' }), { inputChars: 3000 });
    expect((await getSpendStatus('acme')).spentUsd).toBe(0);
    const b = await reserveSpend(call());
    await releaseSpend(b, Object.assign(new Error('t'), { name: 'APIConnectionTimeoutError' }), { inputChars: 3000 });
    expect((await getSpendStatus('acme')).spentUsd).toBeCloseTo(0.003, 6);
  });

  it('a crashed worker\'s reservation is swept as SPENT, not forgotten', async () => {
    reg.cfg = { mode: 'capped', capUsd: 0.15 };
    await reserveSpend(call());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + RESERVATION_TTL_MS + 1000);
    await expect(reserveSpend(call())).rejects.toMatchObject({ code: 'SPEND_CAP_REACHED' });
    vi.useRealTimers();
  });

  it('tenants are isolated', async () => {
    reg.cfg = { mode: 'capped', capUsd: 0.13 };
    await reserveSpend(call('a'));
    await expect(reserveSpend(call('a'))).rejects.toBeInstanceOf(SpendGuardError);
    await expect(reserveSpend(call('b'))).resolves.toBeTruthy();
  });
});

describe('before the first invoice clears', () => {
  it('Stripe-backed tenant with no paid invoice is held to the unverified cap', async () => {
    reg.customer = 'cus_1'; reg.cfg = { mode: 'capped', capUsd: 150 };
    process.env.AEGIS_UNVERIFIED_CAP_USD = '0.2';
    await reserveSpend(call());
    await expect(reserveSpend(call())).rejects.toMatchObject({ code: 'SPEND_CAP_REACHED', meta: { unverified: true } });
    delete process.env.AEGIS_UNVERIFIED_CAP_USD;
  });

  it('cap lifts to the tier cap after first paid invoice', async () => {
    reg.customer = 'cus_1'; reg.firstPaid = Date.now();
    expect((await getSpendStatus('acme')).capUsd).toBe(15);
  });
});

describe('payment failure', () => {
  it('suspended / pending tenants cannot spend from in-flight work', async () => {
    for (const status of ['suspended', 'pending']) {
      reg.status = status;
      await expect(reserveSpend(call())).rejects.toMatchObject({ code: 'TENANT_INACTIVE' });
    }
  });
});

describe('prepaid mode', () => {
  beforeEach(() => { reg.cfg = { mode: 'prepaid', capUsd: null }; });

  it('refuses at zero balance, serves after top-up, refunds the unused reserve', async () => {
    await expect(reserveSpend(call())).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' });
    await addCredits('acme', 1, 'evt_a');
    const r = await reserveSpend(call());
    await settleSpend(r, { model: 'm', inputTokens: 1000, outputTokens: 500 });
    expect((await getSpendStatus('acme')).creditsUsd).toBeCloseTo(1 - 0.0105, 6);
  });

  it('balance never goes negative through reserve; concurrent calls bounded by balance', async () => {
    await addCredits('acme', 0.5, 'evt_b');
    const r = await Promise.allSettled(Array.from({ length: 20 }, () => reserveSpend(call())));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(3); // floor(0.5 / 0.1259)
    expect((await getSpendStatus('acme')).creditsUsd).toBeGreaterThanOrEqual(0);
  });

  it('top-up is idempotent on ref', async () => {
    expect((await addCredits('acme', 5, 'evt_c')).applied).toBe(true);
    expect((await addCredits('acme', 5, 'evt_c')).applied).toBe(false);
    expect((await getSpendStatus('acme')).creditsUsd).toBe(5);
  });
});

describe('fail closed', () => {
  it('refuses the call if Redis errors', async () => {
    const spy = vi.spyOn(new IORedis(), 'eval').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(reserveSpend(call())).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    spy.mockRestore();
  });
});
