/**
 * tests/free-tier.test.js
 *
 * engine/billing/free-tier.js — hard monthly limits for the free tier only.
 * tenant-registry and allowance are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getTier = vi.fn();
vi.mock('../engine/tenant-registry.js', () => ({ getTier }));
const checkAllowance = vi.fn();
vi.mock('../engine/billing/allowance.js', () => ({ checkAllowance }));

let assertFreeTierLimits;

beforeEach(async () => {
  vi.resetModules();
  getTier.mockReset();
  checkAllowance.mockReset();
  ({ assertFreeTierLimits } = await import('../engine/billing/free-tier.js'));
});

const usage = (map) => (t, ev) => Promise.resolve({ tier: 'free', eventType: ev, ...map[ev] });

describe('assertFreeTierLimits', () => {
  it.each(['starter', 'pro', 'enterprise', null])('does nothing for tier %s', async (tier) => {
    getTier.mockResolvedValue(tier);
    await expect(assertFreeTierLimits('acme')).resolves.toBeUndefined();
    expect(checkAllowance).not.toHaveBeenCalled();
  });

  it('allows a free tenant under both limits', async () => {
    getTier.mockResolvedValue('free');
    checkAllowance.mockImplementation(usage({
      workflow_run: { used: 24, included: 25 }, sandbox_minutes: { used: 5, included: 30 },
    }));
    await expect(assertFreeTierLimits('acme')).resolves.toBeUndefined();
  });

  it('refuses at the workflow-run limit, naming the dimension', async () => {
    getTier.mockResolvedValue('free');
    checkAllowance.mockImplementation(usage({
      workflow_run: { used: 25, included: 25 }, sandbox_minutes: { used: 0, included: 30 },
    }));
    await expect(assertFreeTierLimits('acme')).rejects.toMatchObject({
      name: 'QuotaExceededError', code: 'QUOTA_EXCEEDED',
      meta: { dimension: 'freeTier:workflow_run', current: 25, limit: 25 },
    });
  });

  it('refuses once sandbox minutes are used up, even with runs left', async () => {
    getTier.mockResolvedValue('free');
    checkAllowance.mockImplementation(usage({
      workflow_run: { used: 3, included: 25 }, sandbox_minutes: { used: 30.4, included: 30 },
    }));
    await expect(assertFreeTierLimits('acme')).rejects.toMatchObject({
      meta: { dimension: 'freeTier:sandbox_minutes' },
    });
  });

  it('fails closed when usage cannot be read', async () => {
    getTier.mockResolvedValue('free');
    checkAllowance.mockRejectedValue(new Error('postgres down'));
    await expect(assertFreeTierLimits('acme')).rejects.toThrow('postgres down');
  });
});
