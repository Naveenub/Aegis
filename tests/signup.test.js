/**
 * tests/signup.test.js
 *
 * engine/billing/signup.js — validation, duplicate tenant, payment gating
 * (pending vs active), Stripe failure, and rollback of a partial signup.
 * All collaborators are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const stripe = { provisionSubscription: vi.fn(), cancelSubscription: vi.fn(), getBasePrice: vi.fn() };
vi.mock('../engine/billing/stripe-customer.js', () => stripe);

let signupTenant;

const RUNNER_KEYS = ['DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'AEGIS_SANDBOX_MODE', 'AEGIS_SANDBOX_DISABLE', 'CI', 'AEGIS_ALLOW_UNSANDBOXED_SIGNUP'];
const savedRunnerEnv = Object.fromEntries(RUNNER_KEYS.map((k) => [k, process.env[k]]));
function restoreRunnerEnv() {
  for (const k of RUNNER_KEYS) { if (savedRunnerEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedRunnerEnv[k]; }
}
afterEach(restoreRunnerEnv);

beforeEach(async () => {
  // Signup requires an authenticated remote runner; give the general tests one.
  for (const k of RUNNER_KEYS) delete process.env[k];
  process.env.DOCKER_HOST = 'tcp://runner.example.com:2376';
  process.env.DOCKER_TLS_VERIFY = '1';
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

describe('signupTenant free tier', () => {
  const free = { email: 'a@b.co', tenantId: 'acme', tier: 'free' };

  it('creates an ACTIVE tenant with a usable key and touches no Stripe object', async () => {
    const r = await signupTenant(free);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      tenantId: 'acme', tier: 'free', apiKey: 'raw_key', status: 'active',
      clientSecret: null, stripeCustomerId: null, stripeSubscriptionId: null,
    });
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
    expect(reg.setStripeCustomerId).not.toHaveBeenCalled();
    expect(reg.setStatus).toHaveBeenCalledWith('acme', 'active');
    expect(reg.setTier).toHaveBeenCalledWith('acme', 'free');
  });

  it('applies the free quota and keeps the email for a later upgrade', async () => {
    await signupTenant(free);
    expect(setQuota).toHaveBeenCalledWith('acme', expect.objectContaining({ maxActiveWorkflows: 1, maxDailyWorkflows: 3 }));
    expect(reg.registerTenant).toHaveBeenCalledWith('acme', expect.objectContaining({ email: 'a@b.co' }));
  });

  it('still requires an isolated runner, same as paid signup', async () => {
    delete process.env.DOCKER_HOST;
    vi.resetModules();
    ({ signupTenant } = await import('../engine/billing/signup.js'));
    expect((await signupTenant(free)).status).toBe(503);
  });

  it('removes the partial tenant if provisioning fails, with no Stripe rollback to attempt', async () => {
    createKey.mockRejectedValue(new Error('redis down'));
    const r = await signupTenant(free);
    expect(r.status).toBe(500);
    expect(reg.removeTenant).toHaveBeenCalledWith('acme');
    expect(stripe.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe('isolated runner guard', () => {
  const clear = () => { for (const k of RUNNER_KEYS) delete process.env[k]; };
  afterEach(() => { restoreRunnerEnv(); delete process.env.STRIPE_PUBLISHABLE_KEY; });

  it('503s config and signup when no runner is configured (local mode)', async () => {
    clear();
    process.env.AEGIS_SANDBOX_MODE = 'local';
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
    const { getSignupConfig, signupTenant } = await import('../engine/billing/signup.js');
    expect((await getSignupConfig()).status).toBe(503);
    expect((await signupTenant({ email: 'a@b.co', tenantId: 'acme' })).status).toBe(503);
    expect(stripe.provisionSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy AEGIS_SANDBOX_DISABLE', { AEGIS_SANDBOX_DISABLE: 'true' }],
    ['CI=true with no DOCKER_HOST', { CI: 'true' }],
    ['nothing configured', {}],
    ['same-machine unix socket', { DOCKER_HOST: 'unix:///var/run/docker.sock', DOCKER_TLS_VERIFY: '1' }],
    ['plaintext tcp daemon (compose dind)', { DOCKER_HOST: 'tcp://dind:2375' }],
    ['tcp daemon with TLS verify off', { DOCKER_HOST: 'tcp://runner:2376', DOCKER_TLS_VERIFY: '0' }],
  ])('blocks signup: %s', async (_n, env) => {
    clear();
    Object.assign(process.env, env);
    const { unsandboxedSignupBlocked } = await import('../engine/billing/signup.js');
    expect(unsandboxedSignupBlocked()).toBe(true);
  });

  it.each([
    ['mutual-TLS tcp runner', { DOCKER_HOST: 'tcp://runner:2376', DOCKER_TLS_VERIFY: '1' }],
    ['ssh runner', { DOCKER_HOST: 'ssh://deploy@runner' }],
  ])('allows signup: %s', async (_n, env) => {
    clear();
    Object.assign(process.env, env);
    const { unsandboxedSignupBlocked } = await import('../engine/billing/signup.js');
    expect(unsandboxedSignupBlocked()).toBe(false);
  });

  it('explains why signup is off and what to set', async () => {
    clear();
    const { signupTenant, signupBlockedReason } = await import('../engine/billing/signup.js');
    const res = await signupTenant({ email: 'a@b.co', tenantId: 'acme' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/DOCKER_HOST/);
    process.env.DOCKER_HOST = 'tcp://dind:2375';
    expect(signupBlockedReason()).toMatch(/DOCKER_TLS_VERIFY/);
    process.env.DOCKER_HOST = 'unix:///var/run/docker.sock';
    expect(signupBlockedReason()).toMatch(/same-machine/);
    process.env.DOCKER_HOST = 'ssh://deploy@runner';
    expect(signupBlockedReason()).toBeNull();
  });

  it('startup check warns on Render when DOCKER_HOST is missing', async () => {
    const { logRunnerStartupStatus } = await import('../engine/billing/signup.js');
    const log = { warn: vi.fn(), info: vi.fn() };
    logRunnerStartupStatus({ RENDER: 'true' }, log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('DOCKER_HOST is not set'));
    const ok = { warn: vi.fn(), info: vi.fn() };
    logRunnerStartupStatus({ RENDER: 'true', DOCKER_HOST: 'tcp://r:2376', DOCKER_TLS_VERIFY: '1' }, ok);
    expect(ok.warn).not.toHaveBeenCalled();
    expect(ok.info).not.toHaveBeenCalled();
  });

  it('allows explicit opt-in for demo deploys', async () => {
    clear();
    process.env.AEGIS_SANDBOX_MODE = 'local';
    process.env.AEGIS_ALLOW_UNSANDBOXED_SIGNUP = 'true';
    const { unsandboxedSignupBlocked } = await import('../engine/billing/signup.js');
    expect(unsandboxedSignupBlocked()).toBe(false);
  });
});

describe('getSignupConfig', () => {
  const saved = process.env.STRIPE_PUBLISHABLE_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
    else process.env.STRIPE_PUBLISHABLE_KEY = saved;
  });

  it('503s when the publishable key is unset', async () => {
    delete process.env.STRIPE_PUBLISHABLE_KEY;
    const { getSignupConfig } = await import('../engine/billing/signup.js');
    expect((await getSignupConfig()).status).toBe(503);
  });

  it('503s when the value is not a publishable key (e.g. a secret key pasted by mistake)', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'sk_live_oops';
    const { getSignupConfig } = await import('../engine/billing/signup.js');
    const r = await getSignupConfig();
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain('sk_live_oops');
  });

  it('returns the key, only the self-serve tiers, and their Stripe prices', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
    stripe.getBasePrice.mockImplementation(async (t) => ({ amount: t === 'pro' ? 9900 : 2900, currency: 'usd', interval: 'month' }));
    const { getSignupConfig } = await import('../engine/billing/signup.js');
    const r = await getSignupConfig();
    expect(r.status).toBe(200);
    expect(r.body.publishableKey).toBe('pk_test_123');
    expect(r.body.tiers.map((t) => t.id)).toEqual(['free', 'starter', 'pro']);
    expect(r.body.tiers[2].price).toEqual({ amount: 9900, currency: 'usd', interval: 'month' });
    // free is a fixed zero, never looked up in Stripe
    expect(r.body.tiers[0].price).toEqual({ amount: 0, currency: 'usd', interval: 'month' });
    expect(stripe.getBasePrice).not.toHaveBeenCalledWith('free');
    expect(r.body.defaultTier).toBe('free');
  });

  it('still serves config with price null when Stripe lookup fails', async () => {
    process.env.STRIPE_PUBLISHABLE_KEY = 'pk_test_123';
    stripe.getBasePrice.mockRejectedValue(new Error('stripe down'));
    const { getSignupConfig } = await import('../engine/billing/signup.js');
    const r = await getSignupConfig();
    expect(r.status).toBe(200);
    expect(r.body.tiers.filter((t) => t.id !== 'free').every((t) => t.price === null)).toBe(true);
  });
});
