/**
 * engine/billing/credits.js — Stripe Checkout session for prepaid credit top-ups.
 * Fulfilment is in stripe-webhook.js (checkout.session.completed, kind=credit_topup).
 * 1 USD paid = 1 USD of credit; credits are consumed at Anthropic cost
 * (spend-guard.js), so apply any margin in the amount charged, not here.
 */
import Stripe from 'stripe';
import { getStripeCustomerId } from '../tenant-registry.js';

let _client = null;
const getClient = () => (_client ??= new Stripe(process.env.STRIPE_SECRET_KEY));

export const MIN_TOPUP_USD = 10;
export const MAX_TOPUP_USD = 10_000;

/** @returns {Promise<{ url: string }>} */
export async function createCreditCheckout(tenantId, usd, returnUrl = process.env.BILLING_RETURN_URL) {
  if (!returnUrl) throw new Error('No return URL — set BILLING_RETURN_URL.');
  if (!Number.isFinite(usd) || usd < MIN_TOPUP_USD || usd > MAX_TOPUP_USD) {
    throw new Error(`usd must be between ${MIN_TOPUP_USD} and ${MAX_TOPUP_USD}.`);
  }
  const customer = await getStripeCustomerId(tenantId);
  if (!customer) throw new Error('Tenant has no Stripe customer.');
  const session = await getClient().checkout.sessions.create({
    mode: 'payment',
    customer,
    client_reference_id: tenantId,
    metadata: { tenantId, kind: 'credit_topup' },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(usd * 100),
        product_data: { name: 'AEGIS prepaid credits' },
      },
    }],
    success_url: returnUrl,
    cancel_url: returnUrl,
  });
  return { url: session.url };
}
