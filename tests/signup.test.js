/**
 * tests/signup.test.js
 *
 * engine/billing/signup.js — validation, duplicate tenant, payment gating
 * (pending vs active), Stripe failure, and rollback of a partial signup.
 * All collaborators are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reg = {
  getTenant: vi.fn(), registerTenant: vi.fn(), setTier: vi.fn(),
  setStripeCustomerId: vi.fn(), setStatus: vi.fn(), removeTenant: vi.fn(),
};
vi.mock('../engine/tenant-registry.js', () => reg);
const setQuota = vi.fn();
vi.mock('../engine/tenant-quota.js', () => ({ setQuota }));
const createKey = vi.fn();
vi.mock('../engine/key-store.js', () => ({ createKey }));
const recordAuditEvent = vi.fn();
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent }));
const stripe = { provisionSubscription: vi.fn(), cancelSubscription: vi.fn() };
vi.mock('../engine/billing/stripe-customer.js', () => stripe);

let signupTenant;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const f of [...Object.values(reg), setQuota, createKey, recordAuditEvent, ...Object.values(stripe)]) f.mockReset();
  reg.getTenant.mockResolvedValue(null);
  reg.registerTenant.mockResolvedValue({ tenantId: 'acme', created: true });
  reg.removeTenant.mockResolvedValue(undefined);
  createKey.mockResolvedValue({ rawKey: 'raw_key', keyId: 'k_1' });
  recordAuditEvent.mockResolvedValue(undefined);
  stripe.cancelSubscription.mockResolvedValue(undefined);
  stripe.provisionSubscription.mockResolvedValue({
    customerId: 'cus_1', subscriptionId: 'sub_1', status: 'incomplete', clientSecret: 'cs_1',
  });
  ({ signupTenant } = await import('../engine/billing/signup.js'));
});

const valid = { email: 'a@b.co', tenantId: 'acme', tier: 'pro' };

describe('signupTenant validation', () => {
  it.each([
    [{ tenantId: 'acme' }, '`email`'],
    [{ email: 'nope', tenantId: 'acme' }, '`email`'],
    [{ email: 'a@b.co' }, '`tenantId`'],
    [{ email: 'a@b.co', tenantId: '   ' }, '`tenantId`'],
    [{ email: 'a@b.co', tenantId: 'acme', tier: 'gold' }, 'Unknown tier'],
  ])('400 for %j', async (input, msg) => {
    const r = await signupTenant(input);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(msg);
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
  });

  it('400 for a missing body', async () => {
    expect((await signupTenant(undefined)).status).toBe(400);
  });

  it('409 when the tenant already exists, before touching Stripe', async () => {
    reg.getTenant.mockResolvedValue({ tenantId: 'acme' });
    const r = await signupTenant(valid);
    expect(r.status).toBe(409);
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
  });
});

describe('signupTenant provisioning', () => {
  it('creates a PENDING tenant and returns the key plus clientSecret when payment is needed', async () => {
    const r = await signupTenant(valid);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      tenantId: 'acme', tier: 'pro', apiKey: 'raw_key', status: 'pending', clientSecret: 'cs_1',
      stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
    });
    expect(reg.setStatus).toHaveBeenCalledWith('acme', 'pending');
    expect(reg.setStripeCustomerId).toHaveBeenCalledWith('acme', 'cus_1');
    expect(reg.setTier).toHaveBeenCalledWith('acme', 'pro');
    expect(setQuota).toHaveBeenCalledWith('acme', expect.objectContaining({ maxActiveWorkflows: 10 }));
  });

  it('is ACTIVE immediately when Stripe reports the subscription active', async () => {
    stripe.provisionSubscription.mockResolvedValue({
      customerId: 'cus_1', subscriptionId: 'sub_1', status: 'active', clientSecret: null,
    });
    const r = await signupTenant(valid);
    expect(r.body.status).toBe('active');
    expect(reg.setStatus).toHaveBeenCalledWith('acme', 'active');
  });

  it('defaults to the starter tier and trims the tenant id', async () => {
    await signupTenant({ email: 'a@b.co', tenantId: '  acme  ' });
    expect(stripe.provisionSubscription).toHaveBeenCalledWith({ email: 'a@b.co', tenantId: 'acme', tier: 'starter' });
  });

  it('502 and no local state when Stripe provisioning fails', async () => {
    stripe.provisionSubscription.mockRejectedValue(new Error('no price'));
    const r = await signupTenant(valid);
    expect(r.status).toBe(502);
    expect(reg.registerTenant).not.toHaveBeenCalled();
  });

  it('rolls back the subscription and partial tenant when local provisioning fails', async () => {
    createKey.mockRejectedValue(new Error('redis down'));
    const r = await signupTenant(valid);
    expect(r.status).toBe(500);
    expect(stripe.cancelSubscription).toHaveBeenCalledWith('sub_1');
    expect(reg.removeTenant).toHaveBeenCalledWith('acme');
  });
});
