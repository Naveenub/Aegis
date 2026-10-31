/**
 * tests/stripe-plan-change.test.js
 *
 * engine/billing/stripe-customer.js plan-change calls, against a mocked Stripe
 * client: what is sent for each kind of change. This checks our requests are
 * well-formed and ordered; it does NOT prove Stripe's behaviour. See the
 * test-mode checklist in docs-site/docs/billing.md before going live.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = {
  customers: { create: vi.fn() },
  subscriptions: { create: vi.fn(), list: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  subscriptionSchedules: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn(), release: vi.fn() },
};
vi.mock('stripe', () => ({ default: vi.fn().mockImplementation(() => client) }));

const EVENTS = ['WORKFLOW_RUN', 'AGENT_STEP', 'TOKENS_IN', 'TOKENS_OUT', 'SANDBOX_MINUTES'];
function setPrices() {
  for (const T of ['STARTER', 'PRO', 'ENTERPRISE']) {
    process.env[`STRIPE_PRICE_${T}`] = `price_${T}_base`;
    for (const e of EVENTS) process.env[`STRIPE_PRICE_${T}_${e}`] = `price_${T}_${e}`;
  }
}
const proPrices = ['price_PRO_base', ...EVENTS.map((e) => `price_PRO_${e}`)];
const starterPrices = ['price_STARTER_base', ...EVENTS.map((e) => `price_STARTER_${e}`)];

let sc;

beforeEach(async () => {
  vi.resetModules();
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  setPrices();
  for (const group of Object.values(client)) for (const fn of Object.values(group)) fn.mockReset();
  client.customers.create.mockResolvedValue({ id: 'cus_new' });
  client.subscriptions.create.mockResolvedValue({ id: 'sub_new', status: 'incomplete', latest_invoice: { confirmation_secret: { client_secret: 'cs_1' } } });
  client.subscriptions.update.mockResolvedValue({});
  client.subscriptions.cancel.mockResolvedValue({});
  client.subscriptionSchedules.release.mockResolvedValue({});
  sc = await import('../engine/billing/stripe-customer.js');
});

const sub = (over = {}) => ({
  id: 'sub_1', status: 'active', metadata: { tenantId: 'acme', tier: 'starter' },
  items: { data: [{ id: 'si_1', current_period_end: 1793491200 }, { id: 'si_2' }] },
  schedule: null, cancel_at_period_end: false, ...over,
});

describe('provisionSubscription', () => {
  it('stamps the tier on the subscription and creates a customer', async () => {
    const r = await sc.provisionSubscription({ email: 'a@b.co', tenantId: 'acme', tier: 'pro' });
    expect(client.customers.create).toHaveBeenCalledWith({ email: 'a@b.co', metadata: { tenantId: 'acme' } });
    const args = client.subscriptions.create.mock.calls[0][0];
    expect(args.metadata).toEqual({ tenantId: 'acme', tier: 'pro' });
    expect(args.items.map((i) => i.price)).toEqual(proPrices);
    expect(args.payment_behavior).toBe('default_incomplete');
    expect(r).toEqual({ customerId: 'cus_new', subscriptionId: 'sub_new', status: 'incomplete', clientSecret: 'cs_1' });
  });

  it('reuses an existing customer instead of creating a second one', async () => {
    const r = await sc.provisionSubscription({ email: 'a@b.co', tenantId: 'acme', tier: 'starter', customerId: 'cus_old' });
    expect(client.customers.create).not.toHaveBeenCalled();
    expect(client.subscriptions.create.mock.calls[0][0].customer).toBe('cus_old');
    expect(r.customerId).toBe('cus_old');
  });

  it('refuses the free tier: it has no Stripe prices', async () => {
    await expect(sc.provisionSubscription({ email: 'a@b.co', tenantId: 'acme', tier: 'free' })).rejects.toThrow('no Stripe prices');
    expect(client.customers.create).not.toHaveBeenCalled();
  });

  it('names the missing env var when a price is not configured', async () => {
    delete process.env.STRIPE_PRICE_PRO_TOKENS_OUT;
    await expect(sc.provisionSubscription({ email: 'a@b.co', tenantId: 'acme', tier: 'pro' })).rejects.toThrow('STRIPE_PRICE_PRO_TOKENS_OUT');
  });
});

describe('findLiveSubscription / cancelIncompleteSubscriptions', () => {
  it('returns the paying subscription and ignores dead ones', async () => {
    client.subscriptions.list.mockResolvedValue({ data: [{ id: 'a', status: 'canceled' }, { id: 'b', status: 'past_due' }] });
    expect((await sc.findLiveSubscription('cus_1')).id).toBe('b');
    client.subscriptions.list.mockResolvedValue({ data: [{ id: 'a', status: 'canceled' }] });
    expect(await sc.findLiveSubscription('cus_1')).toBeNull();
  });

  it('cancels every incomplete subscription', async () => {
    client.subscriptions.list.mockResolvedValue({ data: [{ id: 'i1' }, { id: 'i2' }] });
    await sc.cancelIncompleteSubscriptions('cus_1');
    expect(client.subscriptions.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'incomplete' }));
    expect(client.subscriptions.cancel.mock.calls.map((c) => c[0])).toEqual(['i1', 'i2']);
  });
});

describe('upgradeSubscription', () => {
  it('swaps every item for the new tier, invoices the proration now, and fails rather than half-change', async () => {
    const r = await sc.upgradeSubscription({ sub: sub(), tier: 'pro' });
    const [id, args] = client.subscriptions.update.mock.calls[0];
    expect(id).toBe('sub_1');
    expect(args.items.slice(0, 2)).toEqual([{ id: 'si_1', deleted: true }, { id: 'si_2', deleted: true }]);
    expect(args.items.slice(2).map((i) => i.price)).toEqual(proPrices);
    expect(args.metadata).toEqual({ tier: 'pro', downgradeTo: '' });
    expect(args.proration_behavior).toBe('always_invoice');
    expect(args.payment_behavior).toBe('error_if_incomplete');
    expect(r).toEqual({ effective: 'now', tier: 'pro', effectiveAt: null });
  });

  it('releases a pending downgrade schedule first, or Stripe refuses the update', async () => {
    await sc.upgradeSubscription({ sub: sub({ schedule: 'sub_sched_1' }), tier: 'pro' });
    expect(client.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_1');
    const release = client.subscriptionSchedules.release.mock.invocationCallOrder[0];
    const update = client.subscriptions.update.mock.invocationCallOrder[0];
    expect(release).toBeLessThan(update);
  });

  it('refuses a free target', async () => {
    await expect(sc.upgradeSubscription({ sub: sub(), tier: 'free' })).rejects.toThrow('no Stripe prices');
    expect(client.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('scheduleDowngrade', () => {
  const schedule = {
    id: 'sub_sched_1',
    phases: [{ start_date: 1790899200, end_date: 1793491200, items: [{ price: 'price_PRO_base' }, { price: { id: 'price_PRO_TOKENS_IN' } }] }],
  };

  it('keeps the current plan for this period, then runs the new tier for one cycle and releases', async () => {
    client.subscriptionSchedules.create.mockResolvedValue({ id: 'sub_sched_1' });
    client.subscriptionSchedules.retrieve.mockResolvedValue(schedule);
    const r = await sc.scheduleDowngrade({ sub: sub({ metadata: { tenantId: 'acme', tier: 'pro' } }), fromTier: 'pro', tier: 'starter' });

    expect(client.subscriptionSchedules.create).toHaveBeenCalledWith({ from_subscription: 'sub_1' });
    const [id, args] = client.subscriptionSchedules.update.mock.calls[0];
    expect(id).toBe('sub_sched_1');
    expect(args.end_behavior).toBe('release');
    expect(args.phases).toHaveLength(2);
    expect(args.phases[0]).toEqual({
      items: [{ price: 'price_PRO_base' }, { price: 'price_PRO_TOKENS_IN' }],
      start_date: 1790899200, end_date: 1793491200,
      metadata: { tenantId: 'acme', tier: 'pro' },
    });
    expect(args.phases[1].items.map((i) => i.price)).toEqual(starterPrices);
    expect(args.phases[1].iterations).toBe(1);
    expect(args.phases[1].metadata).toEqual({ tenantId: 'acme', tier: 'starter' });
    expect(r).toEqual({ effective: 'period_end', tier: 'starter', effectiveAt: '2026-11-01T00:00:00.000Z' });
  });

  it('reuses an existing schedule rather than creating another', async () => {
    client.subscriptionSchedules.retrieve.mockResolvedValue(schedule);
    await sc.scheduleDowngrade({ sub: sub({ schedule: 'sub_sched_1' }), fromTier: 'pro', tier: 'starter' });
    expect(client.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(client.subscriptionSchedules.retrieve).toHaveBeenCalledWith('sub_sched_1');
  });

  it('first drops a pending cancel-at-period-end so the two do not conflict', async () => {
    client.subscriptionSchedules.create.mockResolvedValue({ id: 'sub_sched_1' });
    client.subscriptionSchedules.retrieve.mockResolvedValue(schedule);
    await sc.scheduleDowngrade({ sub: sub({ cancel_at_period_end: true }), fromTier: 'pro', tier: 'starter' });
    expect(client.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false, metadata: { downgradeTo: '' } });
  });
});

describe('scheduleCancelToFree / keepCurrentPlan', () => {
  it('cancels at period end and marks the destination as free', async () => {
    const r = await sc.scheduleCancelToFree({ sub: sub() });
    expect(client.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: true, metadata: { downgradeTo: 'free' } });
    expect(r).toMatchObject({ effective: 'period_end', tier: 'free', effectiveAt: '2026-11-01T00:00:00.000Z' });
  });

  it('keepCurrentPlan releases a schedule and un-cancels', async () => {
    await sc.keepCurrentPlan({ sub: sub({ schedule: 'sub_sched_1', cancel_at_period_end: true }), tier: 'starter' });
    expect(client.subscriptionSchedules.release).toHaveBeenCalledWith('sub_sched_1');
    expect(client.subscriptions.update).toHaveBeenCalledWith('sub_1', { cancel_at_period_end: false, metadata: { downgradeTo: '' } });
  });

  it('keepCurrentPlan touches nothing when there is nothing pending', async () => {
    await sc.keepCurrentPlan({ sub: sub(), tier: 'starter' });
    expect(client.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(client.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe('provisionSubscription tax', () => {
  it('sends GST rates and address when AEGIS_TAX_MODE=gst', async () => {
    Object.assign(process.env, {
      AEGIS_TAX_MODE: 'gst', AEGIS_TAX_HOME_STATE: 'KA',
      STRIPE_TAXRATE_IN_CGST: 'txr_c', STRIPE_TAXRATE_IN_SGST: 'txr_s', STRIPE_TAXRATE_IN_IGST: 'txr_i',
    });
    vi.resetModules();
    sc = await import('../engine/billing/stripe-customer.js');
    await sc.provisionSubscription({ email: 'a@b.co', tenantId: 'acme', tier: 'pro', billingAddress: { country: 'IN', state: 'MH' } });
    expect(client.customers.create.mock.calls[0][0].address).toEqual({ country: 'IN', state: 'MH' });
    expect(client.subscriptions.create.mock.calls[0][0].default_tax_rates).toEqual(['txr_i']);
    for (const k of ['AEGIS_TAX_MODE', 'AEGIS_TAX_HOME_STATE', 'STRIPE_TAXRATE_IN_CGST', 'STRIPE_TAXRATE_IN_SGST', 'STRIPE_TAXRATE_IN_IGST']) delete process.env[k];
  });
});
