/**
 * tests/billing-tiers-allowance.test.js
 *
 * engine/billing/tiers.js (config shape, fallback) and
 * engine/billing/allowance.js (used/included/overage, unlimited tier).
 * usage-recorder and tenant-registry are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUsageInPeriodMock = vi.fn();
vi.mock('../engine/usage-recorder.js', () => ({
  EVENT_TYPES: {
    WORKFLOW_RUN: 'workflow_run', AGENT_STEP: 'agent_step',
    TOKENS_IN: 'tokens_in', TOKENS_OUT: 'tokens_out', SANDBOX_MINUTES: 'sandbox_minutes',
  },
  getUsageInPeriod: getUsageInPeriodMock,
}));
const getTierMock = vi.fn();
vi.mock('../engine/tenant-registry.js', () => ({ getTier: getTierMock }));

let tiers, checkAllowance;

beforeEach(async () => {
  vi.resetModules();
  getUsageInPeriodMock.mockReset();
  getTierMock.mockReset();
  tiers = await import('../engine/billing/tiers.js');
  ({ checkAllowance } = await import('../engine/billing/allowance.js'));
});

describe('tiers', () => {
  it('defines starter, pro, enterprise with a quota and every metered allowance', () => {
    const events = ['workflow_run', 'agent_step', 'tokens_in', 'tokens_out', 'sandbox_minutes'];
    for (const name of ['starter', 'pro', 'enterprise']) {
      const t = tiers.TIERS[name];
      expect(t.quota).toEqual(expect.objectContaining({
        maxActiveWorkflows: expect.any(Number),
        maxDailyWorkflows: expect.any(Number),
        maxQueuedJobs: expect.any(Number),
      }));
      for (const e of events) expect(t.allowance).toHaveProperty(e);
    }
  });

  it('allowances grow with the tier and enterprise is unlimited (null)', () => {
    const { starter, pro, enterprise } = tiers.TIERS;
    expect(pro.allowance.tokens_in).toBeGreaterThan(starter.allowance.tokens_in);
    expect(pro.allowance.tokens_out).toBeGreaterThan(starter.allowance.tokens_out);
    expect(Object.values(enterprise.allowance).every((v) => v === null)).toBe(true);
  });

  it('has a free tier that is unpaid, smaller than starter, and has a finite cap', () => {
    const { free, starter } = tiers.TIERS;
    expect(free.paid).toBe(false);
    expect(tiers.isPaidTier('free')).toBe(false);
    expect(tiers.isPaidTier('starter')).toBe(true);
    for (const e of ['workflow_run', 'agent_step', 'tokens_in', 'tokens_out', 'sandbox_minutes']) {
      expect(free.allowance[e]).toBeGreaterThan(0);
      expect(free.allowance[e]).toBeLessThan(starter.allowance[e]);
    }
    expect(free.spend.capUsd).toBeLessThan(starter.spend.capUsd);
    expect(tiers.PAID_TIERS).toEqual(['starter', 'pro', 'enterprise']);
  });

  it('never makes free the fallback for tenants with no stored tier', () => {
    expect(tiers.DEFAULT_TIER).toBe('starter');
    expect(tiers.getTierConfig('free')).toBe(tiers.TIERS.free);
  });

  it('orders tiers so an upgrade can be told from a downgrade', () => {
    expect(tiers.tierRank('pro')).toBeGreaterThan(tiers.tierRank('starter'));
    expect(tiers.tierRank('starter')).toBeGreaterThan(tiers.tierRank('free'));
    expect(tiers.tierRank('nope')).toBe(-1);
  });

  it('is frozen and falls back to the default tier for unknown names', () => {
    expect(Object.isFrozen(tiers.TIERS)).toBe(true);
    expect(tiers.getTierConfig('nope')).toBe(tiers.TIERS[tiers.DEFAULT_TIER]);
    expect(tiers.getTierConfig(undefined)).toBe(tiers.TIERS.starter);
  });
});

describe('checkAllowance', () => {
  it('reports zero overage under the allowance', async () => {
    getTierMock.mockResolvedValue('starter');
    getUsageInPeriodMock.mockResolvedValue(100);
    expect(await checkAllowance('acme', 'workflow_run')).toEqual({
      tier: 'starter', eventType: 'workflow_run', used: 100, included: 500, overage: 0,
    });
  });

  it('reports the overage past the allowance', async () => {
    getTierMock.mockResolvedValue('starter');
    getUsageInPeriodMock.mockResolvedValue(650);
    const r = await checkAllowance('acme', 'workflow_run');
    expect(r.overage).toBe(150);
  });

  it('treats a tenant with no tier as starter', async () => {
    getTierMock.mockResolvedValue(null);
    getUsageInPeriodMock.mockResolvedValue(0);
    expect((await checkAllowance('acme', 'tokens_in')).tier).toBe('starter');
  });

  it('skips the usage query for an unlimited tier', async () => {
    getTierMock.mockResolvedValue('enterprise');
    const r = await checkAllowance('acme', 'tokens_in');
    expect(r).toEqual({ tier: 'enterprise', eventType: 'tokens_in', used: null, included: null, overage: 0 });
    expect(getUsageInPeriodMock).not.toHaveBeenCalled();
  });

  it('queries usage from the first of the current UTC month', async () => {
    getTierMock.mockResolvedValue('pro');
    getUsageInPeriodMock.mockResolvedValue(1);
    await checkAllowance('acme', 'agent_step');
    const since = getUsageInPeriodMock.mock.calls[0][2];
    const now = new Date();
    expect(since.toISOString()).toBe(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString());
  });

  it('rejects an invalid tenant id', async () => {
    await expect(checkAllowance('', 'tokens_in')).rejects.toThrow();
  });
});
