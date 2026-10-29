/**
 * engine/billing/stripe-customer.js
 *
 * Self-serve signup: creates a Stripe customer + subscription (tier base
 * price + one metered subscription item per usage.EVENT_TYPES dimension) in
 * a single call, returning the customer id POST /signup stores via
 * tenant-registry.js setStripeCustomerId(). Usage is reported as Billing Meter events keyed by
 * customer id — see billing/stripe-reporter.js. Metered prices are per tier
 * (STRIPE_PRICE_{TIER}_{EVENT_TYPE}) and attached to the Stripe Meters whose
 * event_name matches stripe-reporter.js — run scripts/stripe-setup.js.
 *
 * Configuration: STRIPE_SECRET_KEY, STRIPE_PRICE_{TIER} (base price per
 * tier), and STRIPE_PRICE_{TIER}_{WORKFLOW_RUN|AGENT_STEP|TOKENS_IN|TOKENS_OUT|SANDBOX_MINUTES}.
 */

import Stripe from 'stripe';
import { EVENT_TYPES } from '../usage-recorder.js';
import { isPaidTier } from './tiers.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

function requirePrice(envVar) {
  const price = process.env[envVar];
  if (!price) throw new Error(`No Stripe price configured — set ${envVar}.`);
  return price;
}

/**
 * Price ids for a paid tier: the base price first, then one graduated metered
 * price per usage event. Created by scripts/stripe-setup.js.
 * @param {string} tier
 * @returns {string[]}
 */
function priceIdsForTier(tier) {
  if (!isPaidTier(tier)) throw new Error(`Tier "${tier}" has no Stripe prices.`);
  const T = tier.toUpperCase();
  return [
    requirePrice(`STRIPE_PRICE_${T}`),
    ...Object.values(EVENT_TYPES).map((eventType) => requirePrice(`STRIPE_PRICE_${T}_${eventType.toUpperCase()}`)),
  ];
}

/**
 * Create a Stripe customer (or reuse one) + subscription for a tenant.
 * The tier is stamped on the subscription metadata: the Stripe webhook reads
 * it back to move the tenant to this tier once payment clears, so the tier a
 * tenant runs on only changes when Stripe says the change is real.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.tenantId  - stored as customer/subscription metadata for support lookups
 * @param {string} params.tier      - 'starter' | 'pro' | 'enterprise'
 * @param {string} [params.customerId] - reuse an existing customer (free tenant upgrading)
 * @returns {Promise<{ customerId: string, subscriptionId: string, status: string, clientSecret: string|null }>}
 */
export async function provisionSubscription({ email, tenantId, tier, customerId }) {
  const client = getClient();
  // Per-tier prices: base + graduated metered (the tier's included allowance is
  // the free first band, overage is priced above it).
  const [basePrice, ...meteredPrices] = priceIdsForTier(tier);

  const customer = customerId
    ? { id: customerId }
    : await client.customers.create({ email, metadata: { tenantId } });

  const subscription = await client.subscriptions.create({
    customer: customer.id,
    items: [{ price: basePrice }, ...meteredPrices.map((price) => ({ price }))],
    metadata: { tenantId, tier },
    // Gate on first payment: subscription stays 'incomplete' until the
    // client confirms the PaymentIntent with clientSecret (Stripe.js).
    payment_behavior: 'default_incomplete',
    payment_settings: { save_default_payment_method: 'on_subscription' },
    expand: ['latest_invoice.confirmation_secret'],
  });

  return {
    customerId: customer.id,
    subscriptionId: subscription.id,
    status: subscription.status, // 'active' only if the first invoice was $0
    clientSecret: subscription.latest_invoice?.confirmation_secret?.client_secret ?? null,
  };
}

// ─── Plan changes ─────────────────────────────────────────────────────────────

const LIVE_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * The customer's current paying subscription, or null.
 * @param {string} customerId
 */
export async function findLiveSubscription(customerId) {
  const subs = await getClient().subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  return subs.data.find((sub) => LIVE_STATUSES.includes(sub.status)) ?? null;
}

/** Cancel abandoned `incomplete` subscriptions so a retried upgrade starts clean. */
export async function cancelIncompleteSubscriptions(customerId) {
  const subs = await getClient().subscriptions.list({ customer: customerId, status: 'incomplete', limit: 20 });
  await Promise.all(subs.data.map((sub) => getClient().subscriptions.cancel(sub.id)));
}

/** Drop a pending downgrade (schedule) or cancel-at-period-end so edits and upgrades can apply. */
async function clearPendingChange(sub) {
  if (sub.schedule) {
    await getClient().subscriptionSchedules.release(typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id);
  }
  if (sub.cancel_at_period_end) {
    await getClient().subscriptions.update(sub.id, { cancel_at_period_end: false, metadata: { downgradeTo: '' } });
  }
}

/** ISO time the current period ends (field moved onto items in recent API versions). */
function periodEndIso(sub) {
  const sec = sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end;
  return sec ? new Date(sec * 1000).toISOString() : null;
}

/**
 * Upgrade now: swap the base + metered items for the new tier's, invoice the
 * prorated base difference immediately, and stamp the new tier. A failed
 * payment raises instead of leaving a half-changed subscription
 * (`error_if_incomplete`). The tenant's tier moves when the webhook sees the
 * paid invoice.
 */
export async function upgradeSubscription({ sub, tier }) {
  await clearPendingChange(sub);
  const items = [
    ...sub.items.data.map((item) => ({ id: item.id, deleted: true })),
    ...priceIdsForTier(tier).map((price) => ({ price })),
  ];
  await getClient().subscriptions.update(sub.id, {
    items,
    metadata: { tier, downgradeTo: '' },
    proration_behavior: 'always_invoice',
    payment_behavior: 'error_if_incomplete',
  });
  return { effective: 'now', tier, effectiveAt: null };
}

/**
 * Downgrade at the end of the paid period via a subscription schedule, so the
 * tenant keeps what it paid for until then. Phase 1 is the current items;
 * phase 2 is the new tier for one cycle, after which the schedule releases
 * and the subscription carries on as the new tier. The phase metadata is what
 * flips `metadata.tier` on the subscription at the boundary.
 */
export async function scheduleDowngrade({ sub, fromTier, tier }) {
  if (sub.cancel_at_period_end) {
    await getClient().subscriptions.update(sub.id, { cancel_at_period_end: false, metadata: { downgradeTo: '' } });
  }
  const tenantId = sub.metadata?.tenantId;
  const client = getClient();
  const scheduleId = sub.schedule
    ? (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id)
    : (await client.subscriptionSchedules.create({ from_subscription: sub.id })).id;
  const schedule = await client.subscriptionSchedules.retrieve(scheduleId);
  const current = schedule.phases[0];

  await client.subscriptionSchedules.update(scheduleId, {
    end_behavior: 'release',
    phases: [
      {
        items: current.items.map((i) => ({ price: typeof i.price === 'string' ? i.price : i.price.id })),
        start_date: current.start_date,
        end_date: current.end_date,
        metadata: { tenantId, tier: fromTier },
      },
      {
        items: priceIdsForTier(tier).map((price) => ({ price })),
        iterations: 1,
        metadata: { tenantId, tier },
      },
    ],
  });
  return { effective: 'period_end', tier, effectiveAt: periodEndIso(sub) };
}

/**
 * Leave paid tiers for the free tier at period end. The subscription is
 * cancelled at the boundary; stripe-webhook.js reads `downgradeTo` on the
 * deleted subscription and puts the tenant on the free tier instead of
 * suspending it.
 */
export async function scheduleCancelToFree({ sub }) {
  await clearPendingChange(sub);
  await getClient().subscriptions.update(sub.id, {
    cancel_at_period_end: true,
    metadata: { downgradeTo: 'free' },
  });
  return { effective: 'period_end', tier: 'free', effectiveAt: periodEndIso(sub) };
}

/** Undo a pending downgrade / cancel and stay on the current tier. */
export async function keepCurrentPlan({ sub, tier }) {
  await clearPendingChange(sub);
  return { effective: 'now', tier, effectiveAt: null };
}

/**
 * Cancel a subscription immediately. Used to roll back a Stripe subscription
 * when tenant provisioning fails after the subscription was already created,
 * so a failed signup never leaves an orphaned live subscription.
 *
 * @param {string} subscriptionId
 */
export async function cancelSubscription(subscriptionId) {
  await getClient().subscriptions.cancel(subscriptionId);
}

/**
 * Stripe-hosted billing portal session so a tenant can update their card,
 * view invoices, or cancel. Paying an outstanding invoice fires invoice.paid,
 * which re-activates the tenant (see stripe-webhook.js).
 *
 * @param {string} customerId
 * @param {string} [returnUrl]  defaults to BILLING_RETURN_URL
 * @returns {Promise<string>}   portal URL
 */
export async function createPortalSession(customerId, returnUrl = process.env.BILLING_RETURN_URL) {
  if (!returnUrl) throw new Error('No return URL — set BILLING_RETURN_URL.');
  const session = await getClient().billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session.url;
}

/**
 * True if the customer has any subscription that is (or was recently)
 * paying: active, trialing, or past_due. Used by pending-cleanup to avoid
 * deleting a tenant whose payment succeeded but whose webhook was missed.
 *
 * @param {string} customerId
 * @returns {Promise<boolean>}
 */
export async function hasLiveSubscription(customerId) {
  const subs = await getClient().subscriptions.list({ customer: customerId, status: 'all', limit: 20 });
  return subs.data.some((sub) => ['active', 'trialing', 'past_due'].includes(sub.status));
}

/**
 * Delete a Stripe customer (also cancels any incomplete subscriptions).
 * @param {string} customerId
 */
export async function deleteCustomer(customerId) {
  await getClient().customers.del(customerId);
}

/**
 * Display info for a tier's base recurring price, read from Stripe so the
 * signup page never hardcodes amounts. Returns null if the price env var is
 * unset or the price has no fixed unit amount.
 *
 * @param {string} tier
 * @returns {Promise<{ amount: number, currency: string, interval: string|null }|null>}
 */
export async function getBasePrice(tier) {
  const id = process.env[`STRIPE_PRICE_${tier.toUpperCase()}`];
  if (!id) return null;
  const price = await getClient().prices.retrieve(id);
  if (price.unit_amount == null) return null;
  return { amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? null };
}
