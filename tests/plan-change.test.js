/**
 * tests/plan-change.test.js
 *
 * engine/billing/plan-change.js — who may move between which tiers, which
 * Stripe operation each move maps to, and that a paid change never writes the
 * tenant's tier itself (the webhook does, once Stripe confirms).
 * All collaborators are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reg = {
  getTier: vi.fn(), getTenant: vi.fn(), getStripeCustomerId: vi.fn(), setStripeCustomerId: vi.fn(),
  registerTenant: vi.fn(), setTier: vi.fn(), setStatus: vi.fn(), removeTenant: vi.fn(),
};
vi.mock('../engine/tenant-registry.js', () => reg);
vi.mock('../engine/tenant-quota.js', () => ({ setQuota: vi.fn() }));
vi.mock('../engine/key-store.js', () => ({ createKey: vi.fn() }));
const recordAuditEvent = vi.fn();
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent }));
const stripe = {
  provisionSubscription: vi.fn(), cancelSubscription: vi.fn(), getBasePrice: vi.fn(),
  findLiveSubscription: vi.fn(), cancelIncompleteSubscriptions: vi.fn(),
  upgradeSubscription: vi.fn(), scheduleDowngrade: vi.fn(), scheduleCancelToFree: vi.fn(), keepCurrentPlan: vi.fn(),
};
vi.mock('../engine/billing/stripe-customer.js', () => stripe);

let changePlan;

const RUNNER_KEYS = ['DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'AEGIS_ALLOW_UNSANDBOXED_SIGNUP'];
const saved = Object.fromEntries(RUNNER_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of RUNNER_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

beforeEach(async () => {
  for (const k of RUNNER_KEYS) delete process.env[k];
  process.env.DOCKER_HOST = 'tcp://runner.example.com:2376';
  process.env.DOCKER_TLS_VERIFY = '1';
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const f of [...Object.values(reg), ...Object.values(stripe), recordAuditEvent]) f.mockReset();
  recordAuditEvent.mockResolvedValue(undefined);
  reg.getTier.mockResolvedValue('starter');
  reg.getStripeCustomerId.mockResolvedValue('cus_1');
  reg.getTenant.mockResolvedValue({ tenantId: 'acme', email: 'a@b.co' });
  stripe.findLiveSubscription.mockResolvedValue({ id: 'sub_1' });
  stripe.upgradeSubscription.mockResolvedValue({ effective: 'now', tier: 'pro', effectiveAt: null });
  stripe.scheduleDowngrade.mockResolvedValue({ effective: 'period_end', tier: 'starter', effectiveAt: '2026-11-01T00:00:00.000Z' });
  stripe.scheduleCancelToFree.mockResolvedValue({ effective: 'period_end', tier: 'free', effectiveAt: '2026-11-01T00:00:00.000Z' });
  stripe.keepCurrentPlan.mockResolvedValue({ effective: 'now', tier: 'starter', effectiveAt: null });
  stripe.provisionSubscription.mockResolvedValue({ customerId: 'cus_new', subscriptionId: 'sub_new', status: 'incomplete', clientSecret: 'cs_1' });
  ({ changePlan } = await import('../engine/billing/plan-change.js'));
});

describe('validation and who may self-serve', () => {
  it.each([undefined, 'gold', 42])('400 for tier %s', async (tier) => {
    expect((await changePlan({ tenantId: 'acme', tier })).status).toBe(400);
  });

  it('400 for enterprise: sales-led', async () => {
    const r = await changePlan({ tenantId: 'acme', tier: 'enterprise' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/sales-led/);
  });

  it('409 for a tenant with no stored tier (billed by hand)', async () => {
    reg.getTier.mockResolvedValue(null);
    const r = await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(r.status).toBe(409);
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
  });

  it('409 for a tenant already on enterprise', async () => {
    reg.getTier.mockResolvedValue('enterprise');
    expect((await changePlan({ tenantId: 'acme', tier: 'starter' })).status).toBe(409);
  });

  it('409 for a paid tenant with no Stripe customer', async () => {
    reg.getStripeCustomerId.mockResolvedValue(null);
    expect((await changePlan({ tenantId: 'acme', tier: 'pro' })).status).toBe(409);
  });

  it('409 when a paid tenant has no live subscription, pointing at the portal', async () => {
    stripe.findLiveSubscription.mockResolvedValue(null);
    const r = await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/portal/);
  });
});

describe('free → paid', () => {
  beforeEach(() => { reg.getTier.mockResolvedValue('free'); reg.getStripeCustomerId.mockResolvedValue(null); });

  it('creates a subscription with the stored email, returns a clientSecret, and does NOT change the tier', async () => {
    const r = await changePlan({ tenantId: 'acme', tier: 'starter' });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ currentTier: 'free', targetTier: 'starter', effective: 'on_payment', clientSecret: 'cs_1' });
    expect(stripe.provisionSubscription).toHaveBeenCalledWith({ email: 'a@b.co', tenantId: 'acme', tier: 'starter', customerId: null });
    expect(reg.setStripeCustomerId).toHaveBeenCalledWith('acme', 'cus_new');
    expect(reg.setTier).not.toHaveBeenCalled();
    expect(reg.setStatus).not.toHaveBeenCalled();
  });

  it('falls back to the email in the request when none is stored', async () => {
    reg.getTenant.mockResolvedValue({ tenantId: 'acme' });
    await changePlan({ tenantId: 'acme', tier: 'pro', email: 'x@y.co' });
    expect(stripe.provisionSubscription).toHaveBeenCalledWith(expect.objectContaining({ email: 'x@y.co' }));
  });

  it('400 when there is no email anywhere', async () => {
    reg.getTenant.mockResolvedValue({ tenantId: 'acme' });
    const r = await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(r.status).toBe(400);
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
  });

  it('reuses an existing customer and cancels abandoned incomplete subscriptions first', async () => {
    reg.getStripeCustomerId.mockResolvedValue('cus_old');
    await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(stripe.cancelIncompleteSubscriptions).toHaveBeenCalledWith('cus_old');
    expect(stripe.provisionSubscription).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'acme', tier: 'pro', customerId: 'cus_old' }));
    expect(reg.setStripeCustomerId).not.toHaveBeenCalled();
  });

  it('503 without an isolated runner (a paid plan runs tenant code on shared infra)', async () => {
    delete process.env.DOCKER_HOST;
    vi.resetModules();
    ({ changePlan } = await import('../engine/billing/plan-change.js'));
    expect((await changePlan({ tenantId: 'acme', tier: 'starter' })).status).toBe(503);
  });

  it('502 when Stripe provisioning fails', async () => {
    stripe.provisionSubscription.mockRejectedValue(new Error('no price'));
    expect((await changePlan({ tenantId: 'acme', tier: 'starter' })).status).toBe(502);
  });

  it('free → free is a no-op', async () => {
    const r = await changePlan({ tenantId: 'acme', tier: 'free' });
    expect(r.status).toBe(200);
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
  });
});

describe('paid → anything', () => {
  it('starter → pro upgrades now', async () => {
    const r = await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(stripe.upgradeSubscription).toHaveBeenCalledWith({ sub: { id: 'sub_1' }, tier: 'pro' });
    expect(r).toEqual({ status: 200, body: { tenantId: 'acme', currentTier: 'starter', targetTier: 'pro', effective: 'now', effectiveAt: null } });
    expect(reg.setTier).not.toHaveBeenCalled(); // the webhook moves it once the invoice is paid
  });

  it('pro → starter is scheduled for period end, not applied now', async () => {
    reg.getTier.mockResolvedValue('pro');
    const r = await changePlan({ tenantId: 'acme', tier: 'starter' });
    expect(stripe.scheduleDowngrade).toHaveBeenCalledWith({ sub: { id: 'sub_1' }, fromTier: 'pro', tier: 'starter' });
    expect(r.body).toMatchObject({ currentTier: 'pro', targetTier: 'starter', effective: 'period_end', effectiveAt: '2026-11-01T00:00:00.000Z' });
    expect(stripe.upgradeSubscription).not.toHaveBeenCalled();
  });

  it.each(['starter', 'pro'])('%s → free cancels at period end', async (from) => {
    reg.getTier.mockResolvedValue(from);
    const r = await changePlan({ tenantId: 'acme', tier: 'free' });
    expect(stripe.scheduleCancelToFree).toHaveBeenCalledWith({ sub: { id: 'sub_1' } });
    expect(r.body).toMatchObject({ currentTier: from, targetTier: 'free', effective: 'period_end' });
  });

  it('same tier clears a pending change', async () => {
    const r = await changePlan({ tenantId: 'acme', tier: 'starter' });
    expect(stripe.keepCurrentPlan).toHaveBeenCalledWith({ sub: { id: 'sub_1' }, tier: 'starter' });
    expect(r.body.effective).toBe('now');
  });

  it('502 when Stripe rejects the change (e.g. the upgrade payment fails)', async () => {
    stripe.upgradeSubscription.mockRejectedValue(new Error('card declined'));
    const r = await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/card declined/);
  });

  it('records an audit event for the change', async () => {
    await changePlan({ tenantId: 'acme', tier: 'pro' });
    expect(recordAuditEvent).toHaveBeenCalledWith('acme', expect.objectContaining({
      action: 'tenant.plan_change', detail: { from: 'starter', to: 'pro', effective: 'now' },
    }));
  });
});
