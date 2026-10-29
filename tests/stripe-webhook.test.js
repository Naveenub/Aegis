/**
 * tests/stripe-webhook.test.js
 *
 * engine/billing/stripe-webhook.js — status transitions per event type,
 * unknown/unregistered tenants left untouched, bad signature rejected.
 * Stripe signature verification and tenant-registry are mocked; the router
 * is exercised over real HTTP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

const constructEventMock = vi.fn();
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({ webhooks: { constructEvent: constructEventMock } })),
}));

const getTenantMock = vi.fn();
const setStatusMock = vi.fn();
const markFirstPaidMock = vi.fn();
const addCreditsMock = vi.fn();
const getTierMock = vi.fn();
const setTierMock = vi.fn();
const setQuotaMock = vi.fn();
vi.mock('../engine/tenant-registry.js', () => ({
  getTenant: getTenantMock, setStatus: setStatusMock, markFirstPaid: markFirstPaidMock,
  getTier: getTierMock, setTier: setTierMock,
}));
vi.mock('../engine/tenant-quota.js', () => ({ setQuota: setQuotaMock }));
vi.mock('../engine/billing/spend-guard.js', () => ({ addCredits: addCreditsMock }));

let server, base;

beforeEach(async () => {
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  constructEventMock.mockReset();
  getTenantMock.mockReset().mockResolvedValue({ tenantId: 'acme' });
  setStatusMock.mockReset().mockResolvedValue(undefined);
  markFirstPaidMock.mockReset().mockResolvedValue(undefined);
  addCreditsMock.mockReset().mockResolvedValue({ applied: true });
  getTierMock.mockReset().mockResolvedValue('starter'); // a paying tenant unless a test says otherwise
  setTierMock.mockReset().mockResolvedValue(undefined);
  setQuotaMock.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { stripeWebhookRouter } = await import('../engine/billing/stripe-webhook.js');
  const app = express();
  app.use('/webhooks', stripeWebhookRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => new Promise((r) => server.close(r)));

const post = () =>
  fetch(`${base}/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=x' },
    body: '{}',
  });

const event = (type, object) => ({ id: 'evt_1', type, data: { object } });

describe('stripe webhook', () => {
  it('rejects a bad signature', async () => {
    constructEventMock.mockImplementation(() => { throw new Error('bad sig'); });
    expect((await post()).status).toBe(401);
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('invoice.paid activates the tenant (current-API invoice metadata path)', async () => {
    constructEventMock.mockReturnValue(
      event('invoice.paid', { parent: { subscription_details: { metadata: { tenantId: 'acme' } } } })
    );
    expect((await post()).status).toBe(200);
    expect(setStatusMock).toHaveBeenCalledWith('acme', 'active');
  });

  it('invoice.payment_failed suspends the tenant', async () => {
    constructEventMock.mockReturnValue(event('invoice.payment_failed', { subscription_details: { metadata: { tenantId: 'acme' } } }));
    await post();
    expect(setStatusMock).toHaveBeenCalledWith('acme', 'suspended');
  });

  it('customer.subscription.deleted suspends the tenant', async () => {
    constructEventMock.mockReturnValue(event('customer.subscription.deleted', { metadata: { tenantId: 'acme' } }));
    await post();
    expect(setStatusMock).toHaveBeenCalledWith('acme', 'suspended');
  });

  it('checkout.session.completed only logs', async () => {
    constructEventMock.mockReturnValue(event('checkout.session.completed', { client_reference_id: 'acme' }));
    expect((await post()).status).toBe(200);
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('ignores events for tenants that are not registered', async () => {
    getTenantMock.mockResolvedValue(null);
    constructEventMock.mockReturnValue(event('invoice.paid', { metadata: { tenantId: 'ghost' } }));
    expect((await post()).status).toBe(200);
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('returns 500 so Stripe retries when the status write fails', async () => {
    setStatusMock.mockRejectedValue(new Error('redis down'));
    constructEventMock.mockReturnValue(event('invoice.paid', { metadata: { tenantId: 'acme' } }));
    expect((await post()).status).toBe(500);
  });

  it.each([
    ['active', 'active'],
    ['trialing', 'active'],
    ['past_due', 'suspended'],
    ['unpaid', 'suspended'],
    ['canceled', 'suspended'],
  ])('customer.subscription.updated status=%s -> %s', async (subStatus, expected) => {
    constructEventMock.mockReturnValue(
      event('customer.subscription.updated', { status: subStatus, metadata: { tenantId: 'acme' } })
    );
    await post();
    expect(setStatusMock).toHaveBeenCalledWith('acme', expected);
  });

  it('customer.subscription.updated with status=incomplete changes nothing', async () => {
    constructEventMock.mockReturnValue(
      event('customer.subscription.updated', { status: 'incomplete', metadata: { tenantId: 'acme' } })
    );
    expect((await post()).status).toBe(200);
    expect(setStatusMock).not.toHaveBeenCalled();
  });

  it('invoice.paid with amount_paid > 0 stamps first payment; $0 invoice does not', async () => {
    constructEventMock.mockReturnValue(event('invoice.paid', { metadata: { tenantId: 'acme' }, amount_paid: 4900 }));
    await post();
    expect(markFirstPaidMock).toHaveBeenCalledWith('acme');
    markFirstPaidMock.mockClear();
    constructEventMock.mockReturnValue(event('invoice.paid', { metadata: { tenantId: 'acme' }, amount_paid: 0 }));
    await post();
    expect(markFirstPaidMock).not.toHaveBeenCalled();
  });

  it('credit_topup checkout adds credits for the amount paid, keyed on event id', async () => {
    constructEventMock.mockReturnValue(event('checkout.session.completed', {
      metadata: { tenantId: 'acme', kind: 'credit_topup' }, payment_status: 'paid', currency: 'usd', amount_total: 5000,
    }));
    expect((await post()).status).toBe(200);
    expect(addCreditsMock).toHaveBeenCalledWith('acme', 50, 'evt_1');
  });

  it('unpaid or non-topup checkout grants nothing', async () => {
    constructEventMock.mockReturnValue(event('checkout.session.completed', {
      metadata: { tenantId: 'acme', kind: 'credit_topup' }, payment_status: 'unpaid', currency: 'usd', amount_total: 5000,
    }));
    await post();
    constructEventMock.mockReturnValue(event('checkout.session.completed', { metadata: { tenantId: 'acme' }, payment_status: 'paid', currency: 'usd', amount_total: 5000 }));
    await post();
    expect(addCreditsMock).not.toHaveBeenCalled();
  });

  it('top-up failure returns 500 so Stripe retries', async () => {
    addCreditsMock.mockRejectedValue(new Error('redis down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    constructEventMock.mockReturnValue(event('checkout.session.completed', {
      metadata: { tenantId: 'acme', kind: 'credit_topup' }, payment_status: 'paid', currency: 'usd', amount_total: 5000,
    }));
    expect((await post()).status).toBe(500);
  });

  // ── plan changes ──────────────────────────────────────────────────────────

  describe('plan changes', () => {
    const paidInvoice = (tier, extra = {}) => event('invoice.paid', {
      amount_paid: 4900,
      parent: { subscription_details: { metadata: { tenantId: 'acme', tier } } },
      ...extra,
    });

    it('moves the tenant and its quota to the tier on a paid invoice (upgrade)', async () => {
      constructEventMock.mockReturnValue(paidInvoice('pro'));
      expect((await post()).status).toBe(200);
      expect(setTierMock).toHaveBeenCalledWith('acme', 'pro');
      expect(setQuotaMock).toHaveBeenCalledWith('acme', expect.objectContaining({ maxActiveWorkflows: 10, maxDailyWorkflows: 100 }));
      expect(setStatusMock).toHaveBeenCalledWith('acme', 'active');
    });

    it('free -> paid: the tenant becomes the paid tier only when the invoice is paid', async () => {
      getTierMock.mockResolvedValue('free');
      constructEventMock.mockReturnValue(paidInvoice('starter'));
      await post();
      expect(setTierMock).toHaveBeenCalledWith('acme', 'starter');
      expect(markFirstPaidMock).toHaveBeenCalledWith('acme');
    });

    it('does nothing to tier or quota when the tenant is already on it', async () => {
      constructEventMock.mockReturnValue(paidInvoice('starter'));
      await post();
      expect(setTierMock).not.toHaveBeenCalled();
      expect(setQuotaMock).not.toHaveBeenCalled();
    });

    it('applies the new tier from subscription.updated (period-end downgrade phase change)', async () => {
      getTierMock.mockResolvedValue('pro');
      constructEventMock.mockReturnValue(event('customer.subscription.updated', {
        status: 'active', metadata: { tenantId: 'acme', tier: 'starter' },
      }));
      await post();
      expect(setTierMock).toHaveBeenCalledWith('acme', 'starter');
      expect(setQuotaMock).toHaveBeenCalledWith('acme', expect.objectContaining({ maxActiveWorkflows: 3 }));
    });

    it('does not move the tier when the subscription is not paying', async () => {
      constructEventMock.mockReturnValue(event('customer.subscription.updated', {
        status: 'past_due', metadata: { tenantId: 'acme', tier: 'pro' },
      }));
      await post();
      expect(setStatusMock).toHaveBeenCalledWith('acme', 'suspended');
      expect(setTierMock).not.toHaveBeenCalled();
    });

    it.each(['free', 'gold', undefined])('ignores tier metadata %s on a paid invoice', async (tier) => {
      constructEventMock.mockReturnValue(paidInvoice(tier));
      await post();
      expect(setTierMock).not.toHaveBeenCalled();
    });

    it('returns 500 so Stripe retries when the tier write fails', async () => {
      setTierMock.mockRejectedValue(new Error('redis down'));
      constructEventMock.mockReturnValue(paidInvoice('pro'));
      expect((await post()).status).toBe(500);
    });

    it('paid -> free at period end: the tenant lands on free and stays ACTIVE', async () => {
      getTierMock.mockResolvedValue('starter');
      constructEventMock.mockReturnValue(event('customer.subscription.deleted', {
        status: 'canceled', metadata: { tenantId: 'acme', downgradeTo: 'free' },
      }));
      await post();
      expect(setTierMock).toHaveBeenCalledWith('acme', 'free');
      expect(setQuotaMock).toHaveBeenCalledWith('acme', expect.objectContaining({ maxActiveWorkflows: 1, maxDailyWorkflows: 3 }));
      expect(setStatusMock).toHaveBeenCalledWith('acme', 'active');
      expect(setStatusMock).not.toHaveBeenCalledWith('acme', 'suspended');
    });

    it.each([
      ['invoice.payment_failed', { subscription_details: { metadata: { tenantId: 'acme', tier: 'pro' } } }],
      ['customer.subscription.deleted', { metadata: { tenantId: 'acme', tier: 'pro' } }],
      ['customer.subscription.updated', { status: 'incomplete_expired', metadata: { tenantId: 'acme', tier: 'pro' } }],
    ])('never suspends a FREE tenant on %s (a lapsed upgrade attempt)', async (type, obj) => {
      getTierMock.mockResolvedValue('free');
      constructEventMock.mockReturnValue(event(type, obj));
      expect((await post()).status).toBe(200);
      expect(setStatusMock).not.toHaveBeenCalled();
      expect(setTierMock).not.toHaveBeenCalled();
    });

    it('still suspends a paying tenant on payment failure', async () => {
      getTierMock.mockResolvedValue('pro');
      constructEventMock.mockReturnValue(event('invoice.payment_failed', { subscription_details: { metadata: { tenantId: 'acme' } } }));
      await post();
      expect(setStatusMock).toHaveBeenCalledWith('acme', 'suspended');
    });
  });
});
