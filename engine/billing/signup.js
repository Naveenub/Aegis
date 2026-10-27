/**
 * engine/billing/signup.js
 *
 * Self-serve signup orchestration behind POST /signup, kept out of server.js
 * so it is unit-testable. Returns { status, body } for the route to send.
 *
 * Flow: validate → 409 if tenant exists → Stripe customer + incomplete
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
import { getTierConfig, DEFAULT_TIER, TIERS } from './tiers.js';
import { provisionSubscription, cancelSubscription, getBasePrice } from './stripe-customer.js';

/**
 * Paid signup runs tenant code. With AEGIS_SANDBOX_MODE=local (or the legacy AEGIS_SANDBOX_DISABLE=true) that code runs
 * unsandboxed on shared infrastructure, so self-serve signup is refused unless
 * the operator explicitly opts in (demo/trial deploys only).
 */
export function unsandboxedSignupBlocked() {
  return (process.env.AEGIS_SANDBOX_MODE === 'local' || process.env.AEGIS_SANDBOX_DISABLE === 'true')
    && process.env.AEGIS_ALLOW_UNSANDBOXED_SIGNUP !== 'true';
}

export async function signupTenant(input) {
  if (unsandboxedSignupBlocked()) {
    return { status: 503, body: { error: 'Self-serve signup is not available on this deployment.' } };
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

  let subscription;
  try {
    subscription = await provisionSubscription({ email, tenantId: id, tier: resolvedTier });
  } catch (err) {
    console.error('[signup] Stripe provisioning failed', err);
    return { status: 502, body: { error: `Billing provisioning failed: ${err.message}` } };
  }

  try {
    await registerTenant(id, { label });
    await setTier(id, resolvedTier);
    await setQuota(id, getTierConfig(resolvedTier).quota);
    await setStripeCustomerId(id, subscription.customerId);
    const status = subscription.status === 'active' ? 'active' : 'pending';
    await setStatus(id, status);
    const key = await createKey(id, { label: label || 'signup' });

    recordAuditEvent(id, {
      actorId: 'signup',
      action: 'tenant.signup',
      resourceType: 'tenant',
      resourceId: id,
      detail: { tier: resolvedTier, stripeCustomerId: subscription.customerId },
    }).catch((err) => console.error('[audit] tenant.signup', err));

    return {
      status: 201,
      body: {
        tenantId: id,
        tier: resolvedTier,
        apiKey: key.rawKey,
        keyId: key.keyId,
        stripeCustomerId: subscription.customerId,
        stripeSubscriptionId: subscription.subscriptionId,
        status,
        // Confirm payment client-side with Stripe.js; the key works once status is active.
        clientSecret: subscription.clientSecret,
      },
    };
  } catch (err) {
    console.error('[signup] Tenant provisioning failed after Stripe subscription created', err);
    await cancelSubscription(subscription.subscriptionId).catch((e) =>
      console.error('[signup] Failed to roll back Stripe subscription', e));
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
 * Only starter and pro are offered self-serve; enterprise stays sales-led.
 */
export const SELF_SERVE_TIERS = Object.freeze(['starter', 'pro']);

const PRICE_TTL_MS = 5 * 60 * 1000;
let _priceCache = null; // { at, prices }

async function loadPrices() {
  if (_priceCache && Date.now() - _priceCache.at < PRICE_TTL_MS) return _priceCache.prices;
  const prices = {};
  await Promise.all(SELF_SERVE_TIERS.map(async (id) => {
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
      tiers: SELF_SERVE_TIERS.map((id) => ({ id, label: TIERS[id].label, price: prices[id] ?? null })),
      defaultTier: DEFAULT_TIER,
    },
  };
}
