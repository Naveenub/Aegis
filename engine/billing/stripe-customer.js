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
 * tier), and STRIPE_PRICE_{TIER}_{WORKFLOW_RUN|AGENT_STEP|TOKENS|SANDBOX_MINUTES}.
 */

import Stripe from 'stripe';
import { EVENT_TYPES } from '../usage-recorder.js';

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
 * Create a Stripe customer + subscription for a new tenant.
 *
 * @param {object} params
 * @param {string} params.email
 * @param {string} params.tenantId  - stored as customer/subscription metadata for support lookups
 * @param {string} params.tier      - 'starter' | 'pro' | 'enterprise'
 * @returns {Promise<{ customerId: string, subscriptionId: string, status: string, clientSecret: string|null }>}
 */
export async function provisionSubscription({ email, tenantId, tier }) {
  const client = getClient();
  const basePrice = requirePrice(`STRIPE_PRICE_${tier.toUpperCase()}`);
  // Per-tier metered prices (graduated: the tier's included allowance is the
  // free first band, overage is priced above it) — created by
  // scripts/stripe-setup.js as STRIPE_PRICE_{TIER}_{EVENT_TYPE}.
  const metered = Object.values(EVENT_TYPES).map((eventType) => ({
    eventType,
    price: requirePrice(`STRIPE_PRICE_${tier.toUpperCase()}_${eventType.toUpperCase()}`),
  }));

  const customer = await client.customers.create({ email, metadata: { tenantId } });

  const subscription = await client.subscriptions.create({
    customer: customer.id,
    items: [{ price: basePrice }, ...metered.map(({ price }) => ({ price }))],
    metadata: { tenantId },
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
