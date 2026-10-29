/**
 * engine/billing/signup.js
 *
 * Self-serve signup orchestration behind POST /signup, kept out of server.js
 * so it is unit-testable. Returns { status, body } for the route to send.
 *
 * Free tier: no Stripe objects at all. The tenant is registered 'active' with
 * the free tier's quota and its first key works immediately; limits are hard
 * (billing/free-tier.js + spend-guard.js). Upgrading later is POST /billing/plan.
 *
 * Paid tiers — flow: validate → 409 if tenant exists → Stripe customer + incomplete
 * subscription → register tenant (status 'pending' until the first payment is
 * confirmed; 'active' only if Stripe reports the subscription already active)
 * → issue first API key (unusable while pending, see middleware/auth.js).
 * If local provisioning fails after Stripe succeeded, the subscription is
 * cancelled and the half-created tenant removed so the id can be retried.
 */

import { getTenant, registerTenant, setTier, setStripeCustomerId, setStatus, removeTenant } from '../tenant-registry.js';
import { setQuota } from '../tenant-quota.js';
import { createKey } from '../key-store.js';
import { recordAuditEvent } from '../audit-log.js';
import { getTierConfig, DEFAULT_TIER, SIGNUP_DEFAULT_TIER, TIERS, isPaidTier } from './tiers.js';
import { provisionSubscription, cancelSubscription, getBasePrice } from './stripe-customer.js';

/**
 * Paid signup runs tenant code, so self-serve signup is only enabled when an
 * isolated runner is actually configured: DOCKER_HOST pointing at a remote
 * daemon that is authenticated (mutual TLS via DOCKER_TLS_VERIFY, or ssh://).
 * Anything else — no DOCKER_HOST (local mode, CI=true, host Docker), or a
 * plaintext tcp:// daemon such as the docker-compose dind sidecar — is refused
 * unless the operator explicitly opts in (demo/trial deploys only).
 */
export function isolatedRunnerConfigured(env = process.env) {
  const host = (env.DOCKER_HOST ?? '').trim();
  if (!host) return false;
  if (host.startsWith('ssh://')) return true;
  if (!host.startsWith('tcp://')) return false; // unix:// etc. = same-machine daemon
  const tls = (env.DOCKER_TLS_VERIFY ?? '').trim();
  return tls !== '' && tls !== '0' && tls.toLowerCase() !== 'false';
}

export function unsandboxedSignupBlocked(env = process.env) {
  return !isolatedRunnerConfigured(env) && env.AEGIS_ALLOW_UNSANDBOXED_SIGNUP !== 'true';
}

/**
 * Human-readable explanation of why self-serve signup is off (null when it is
 * enabled). Says what is wrong with the runner config and what to set.
 */
export function signupBlockedReason(env = process.env) {
  if (!unsandboxedSignupBlocked(env)) return null;
  const host = (env.DOCKER_HOST ?? '').trim();
  const fix = 'Set DOCKER_HOST to an isolated remote runner (tcp:// with DOCKER_TLS_VERIFY=1, or ssh://).';
  if (!host) {
    return `Self-serve signup is disabled: no isolated sandbox runner is configured. ${fix}`;
  }
  if (host.startsWith('tcp://')) {
    return 'Self-serve signup is disabled: the tcp:// DOCKER_HOST is not authenticated. Set DOCKER_TLS_VERIFY=1 (mutual TLS) or use an ssh:// runner.';
  }
  if (!host.startsWith('ssh://')) {
    return `Self-serve signup is disabled: DOCKER_HOST points at a same-machine daemon, not an isolated runner. ${fix}`;
  }
  return `Self-serve signup is disabled. ${fix}`;
}

/**
 * Startup check: surface a missing/unsafe runner in the logs instead of only
 * as signup 503s. Always warns on Render (no nested Docker, so a missing
 * DOCKER_HOST also blocks every lint/test step); elsewhere it logs at info
 * level when signup is off.
 */
export function logRunnerStartupStatus(env = process.env, log = console) {
  const reason = signupBlockedReason(env);
  const onRender = env.RENDER === 'true';
  const host = (env.DOCKER_HOST ?? '').trim();
  if (onRender && !host) {
    log.warn(
      '[startup] DOCKER_HOST is not set. Render has no nested Docker, so lint/test steps will be ' +
      'blocked and self-serve signup will return 503. Point DOCKER_HOST at your remote runner ' +
      '(e.g. tcp://runner.example.com:2376) with DOCKER_TLS_VERIFY=1 — see the header of render.yaml.',
    );
  } else if (reason) {
    (onRender ? log.warn : log.info)(`[startup] ${reason}`);
  }
  return reason;
}

export async function signupTenant(input) {
  if (unsandboxedSignupBlocked()) {
    return { status: 503, body: { error: signupBlockedReason() } };
  }
  const { email, tenantId, label, tier } = input ?? {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { status: 400, body: { error: '`email` (string) is required.' } };
  }
  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    return { status: 400, body: { error: '`tenantId` (string) is required.' } };
  }
  if (tier !== undefined && !TIERS[tier]) {
    return { status: 400, body: { error: `Unknown tier "${tier}". Valid: ${Object.keys(TIERS).join(', ')}.` } };
  }

  const id = tenantId.trim();
  const resolvedTier = tier ?? DEFAULT_TIER;

  if (await getTenant(id)) {
    return { status: 409, body: { error: `Tenant "${id}" already exists.` } };
  }

  // Free tier: nothing to bill, nothing to confirm.
  const free = !isPaidTier(resolvedTier);

  let subscription = null;
  if (!free) {
    try {
      subscription = await provisionSubscription({ email, tenantId: id, tier: resolvedTier });
    } catch (err) {
      console.error('[signup] Stripe provisioning failed', err);
      return { status: 502, body: { error: `Billing provisioning failed: ${err.message}` } };
    }
  }

  try {
    await registerTenant(id, { label, email });
    await setTier(id, resolvedTier);
    await setQuota(id, getTierConfig(resolvedTier).quota);
    if (subscription) await setStripeCustomerId(id, subscription.customerId);
    const status = free || subscription.status === 'active' ? 'active' : 'pending';
    await setStatus(id, status);
    const key = await createKey(id, { label: label || 'signup' });

    recordAuditEvent(id, {
      actorId: 'signup',
      action: 'tenant.signup',
      resourceType: 'tenant',
      resourceId: id,
      detail: { tier: resolvedTier, stripeCustomerId: subscription?.customerId ?? null },
    }).catch((err) => console.error('[audit] tenant.signup', err));

    return {
      status: 201,
      body: {
        tenantId: id,
        tier: resolvedTier,
        apiKey: key.rawKey,
        keyId: key.keyId,
        stripeCustomerId: subscription?.customerId ?? null,
        stripeSubscriptionId: subscription?.subscriptionId ?? null,
        status,
        // Confirm payment client-side with Stripe.js; the key works once status is active.
        // Null for the free tier.
        clientSecret: subscription?.clientSecret ?? null,
      },
    };
  } catch (err) {
    console.error('[signup] Tenant provisioning failed after signup began', err);
    if (subscription) {
      await cancelSubscription(subscription.subscriptionId).catch((e) =>
        console.error('[signup] Failed to roll back Stripe subscription', e));
    }
    await removeTenant(id).catch((e) => console.error('[signup] Failed to remove partial tenant', e));
    return { status: 500, body: { error: err.message } };
  }
}

/**
 * Public, non-secret config the signup page needs to mount Stripe.js.
 * The publishable key is meant to be exposed to browsers; it is read from
 * STRIPE_PUBLISHABLE_KEY so no key is baked into the landing assets. Without
 * it, self-serve signup is reported as unavailable (503) and the page falls
 * back to the contact email.
 *
 * free, starter and pro are offered self-serve; enterprise stays sales-led.
 */
export const SELF_SERVE_TIERS = Object.freeze(['free', 'starter', 'pro']);

const PRICE_TTL_MS = 5 * 60 * 1000;
let _priceCache = null; // { at, prices }

async function loadPrices() {
  if (_priceCache && Date.now() - _priceCache.at < PRICE_TTL_MS) return _priceCache.prices;
  const prices = {};
  await Promise.all(SELF_SERVE_TIERS.filter(isPaidTier).map(async (id) => {
    try {
      prices[id] = await getBasePrice(id);
    } catch (err) {
      console.error(`[signup] Could not load Stripe price for ${id}`, err.message);
      prices[id] = null; // page falls back to showing no price for this tier
    }
  }));
  _priceCache = { at: Date.now(), prices };
  return prices;
}

export async function getSignupConfig() {
  if (unsandboxedSignupBlocked()) {
    return { status: 503, body: { error: 'Self-serve signup is not configured.' } };
  }
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey || !publishableKey.startsWith('pk_')) {
    return { status: 503, body: { error: 'Self-serve signup is not configured.' } };
  }
  const prices = await loadPrices();
  return {
    status: 200,
    body: {
      publishableKey,
      tiers: SELF_SERVE_TIERS.map((id) => ({
        id,
        label: TIERS[id].label,
        // The free tier has no Stripe price; it is a fixed zero, not a lookup.
        price: isPaidTier(id) ? (prices[id] ?? null) : { amount: 0, currency: 'usd', interval: 'month' },
      })),
      defaultTier: SIGNUP_DEFAULT_TIER,
    },
  };
}
