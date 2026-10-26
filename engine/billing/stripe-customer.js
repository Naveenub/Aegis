/**
 * engine/billing/stripe-customer.js
 *
 * Self-serve signup: creates a Stripe customer + subscription (tier base
 * price + one metered subscription item per usage.EVENT_TYPES dimension) in
 * a single call, returning the customer id POST /signup stores via
 * tenant-registry.js setStripeCustomerId(). Usage is reported as Billing Meter events keyed by
 * customer id — see billing/stripe-reporter.js. The STRIPE_PRICE_* metered
 * prices must each be attached to a Stripe Meter whose event_name matches
 * METER_EVENT_NAME in stripe-reporter.js.
 *
 * Configuration: STRIPE_SECRET_KEY, STRIPE_PRICE_{TIER} (base price per
 * tier), and STRIPE_PRICE_WORKFLOW_RUN / _AGENT_STEP / _TOKENS /
 * _SANDBOX_MINUTES (metered, usage-type prices, shared across tiers).
 */

import Stripe from 'stripe';
import { EVENT_TYPES } from '../usage-recorder.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

const METERED_PRICE_ENV = {
  [EVENT_TYPES.WORKFLOW_RUN]:    'STRIPE_PRICE_WORKFLOW_RUN',
  [EVENT_TYPES.AGENT_STEP]:      'STRIPE_PRICE_AGENT_STEP',
  [EVENT_TYPES.TOKENS]:          'STRIPE_PRICE_TOKENS',
  [EVENT_TYPES.SANDBOX_MINUTES]: 'STRIPE_PRICE_SANDBOX_MINUTES',
};

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
 * @returns {Promise<{ customerId: string, subscriptionId: string }>}
 */
export async function provisionSubscription({ email, tenantId, tier }) {
  const client = getClient();
  const basePrice = requirePrice(`STRIPE_PRICE_${tier.toUpperCase()}`);
  const metered = Object.values(EVENT_TYPES).map((eventType) => ({
    eventType,
    price: requirePrice(METERED_PRICE_ENV[eventType]),
  }));

  const customer = await client.customers.create({ email, metadata: { tenantId } });

  const subscription = await client.subscriptions.create({
    customer: customer.id,
    items: [{ price: basePrice }, ...metered.map(({ price }) => ({ price }))],
    metadata: { tenantId },
  });

  return { customerId: customer.id, subscriptionId: subscription.id };
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
