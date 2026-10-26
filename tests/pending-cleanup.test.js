/**
 * tests/pending-cleanup.test.js
 *
 * engine/billing/pending-cleanup.js — only stale 'pending' tenants are
 * reaped; a live Stripe subscription reconciles instead of deleting; Stripe
 * failure leaves everything local intact; dry-run changes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reg = {
  listTenants: vi.fn(), getTenant: vi.fn(), getStripeCustomerId: vi.fn(),
  setStatus: vi.fn(), removeTenant: vi.fn(),
};
vi.mock('../engine/tenant-registry.js', () => reg);

const keys = { listKeys: vi.fn(), revokeKey: vi.fn() };
vi.mock('../engine/key-store.js', () => keys);

const stripe = { hasLiveSubscription: vi.fn(), deleteCustomer: vi.fn() };
vi.mock('../engine/billing/stripe-customer.js', () => stripe);

const recordAuditEvent = vi.fn();
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent }));
vi.mock('../engine/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const NOW = 1_800_000_000_000;
const HOUR = 3600 * 1000;
const meta = (o) => ({ tenantId: 'x', status: 'pending', createdAt: String(NOW - 72 * HOUR), ...o });

let cleanupPendingTenants;

beforeEach(async () => {
  vi.resetModules();
  Object.values({ ...reg, ...keys, ...stripe }).forEach((f) => f.mockReset());
  recordAuditEvent.mockReset().mockResolvedValue(undefined);
  reg.getStripeCustomerId.mockResolvedValue('cus_1');
  stripe.hasLiveSubscription.mockResolvedValue(false);
  keys.listKeys.mockResolvedValue([{ keyId: 'k1' }, { keyId: 'k2' }]);
  ({ cleanupPendingTenants } = await import('../engine/billing/pending-cleanup.js'));
});

const run = (tenants, opts = {}) => {
  reg.listTenants.mockResolvedValue(Object.keys(tenants));
  reg.getTenant.mockImplementation(async (id) => tenants[id]);
  return cleanupPendingTenants({ now: NOW, ...opts });
};

describe('cleanupPendingTenants', () => {
  it('removes a stale pending tenant: Stripe customer, keys, registry, audit', async () => {
    const r = await run({ acme: meta() });
    expect(stripe.deleteCustomer).toHaveBeenCalledWith('cus_1');
    expect(keys.revokeKey).toHaveBeenCalledWith('acme', 'k1');
    expect(keys.revokeKey).toHaveBeenCalledWith('acme', 'k2');
    expect(reg.removeTenant).toHaveBeenCalledWith('acme');
    expect(recordAuditEvent).toHaveBeenCalledWith('acme', expect.objectContaining({ action: 'tenant.cleanup' }));
    expect(r).toMatchObject({ removed: ['acme'], reconciled: [], failed: [], kept: 0 });
  });

  it('leaves recent pending, suspended, active, and status-less tenants alone', async () => {
    const r = await run({
      fresh: meta({ createdAt: String(NOW - 2 * HOUR) }),
      susp: meta({ status: 'suspended' }),
      act: meta({ status: 'active' }),
      partner: meta({ status: undefined }),
    });
    expect(reg.removeTenant).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    expect(r.kept).toBe(4);
  });

  it('reconciles to active instead of deleting when a live subscription exists', async () => {
    stripe.hasLiveSubscription.mockResolvedValue(true);
    const r = await run({ acme: meta() });
    expect(reg.setStatus).toHaveBeenCalledWith('acme', 'active');
    expect(reg.removeTenant).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    expect(r.reconciled).toEqual(['acme']);
  });

  it('keeps everything local when the Stripe call fails, and continues the batch', async () => {
    stripe.deleteCustomer.mockRejectedValueOnce(new Error('stripe down'));
    const r = await run({ a: meta(), b: meta() });
    expect(r.failed).toEqual(['a']);
    expect(r.removed).toEqual(['b']);
    expect(reg.removeTenant).toHaveBeenCalledTimes(1);
    expect(reg.removeTenant).toHaveBeenCalledWith('b');
  });

  it('removes a tenant with no Stripe customer without calling Stripe delete', async () => {
    reg.getStripeCustomerId.mockResolvedValue(null);
    const r = await run({ acme: meta() });
    expect(stripe.hasLiveSubscription).not.toHaveBeenCalled();
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    expect(r.removed).toEqual(['acme']);
  });

  it('dry-run reports but changes nothing', async () => {
    const r = await run({ acme: meta() }, { dryRun: true });
    expect(r.removed).toEqual(['acme']);
    expect(stripe.deleteCustomer).not.toHaveBeenCalled();
    expect(keys.revokeKey).not.toHaveBeenCalled();
    expect(reg.removeTenant).not.toHaveBeenCalled();
  });
});
