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
vi.mock('../engine/tenant-registry.js', () => ({ getTenant: getTenantMock, setStatus: setStatusMock }));

let server, base;

beforeEach(async () => {
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
  constructEventMock.mockReset();
  getTenantMock.mockReset().mockResolvedValue({ tenantId: 'acme' });
  setStatusMock.mockReset().mockResolvedValue(undefined);
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
});
