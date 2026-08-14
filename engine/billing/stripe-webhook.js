/**
 * engine/billing/stripe-webhook.js
 *
 * Minimal inbound Stripe webhook — verifies the signature and logs a
 * "partner paid" flag line for checkout/invoice payment events. Deliberately
 * does nothing else: no tenant provisioning, no metering, no DB writes. That
 * pipeline is stripe-customer.js / stripe-reporter.js and is unaffected by
 * this file — this exists only so manual Stripe Payment Link invoices
 * (design-partner flow, see scripts/onboard-design-partner.js) show up in
 * server logs instead of only in the Stripe dashboard.
 *
 * Environment variables
 * ──────────────────────
 *   STRIPE_SECRET_KEY      Required — same client used by stripe-customer.js.
 *   STRIPE_WEBHOOK_SECRET  Required — signing secret from the Stripe webhook
 *                          endpoint settings page. No secret = every request
 *                          rejected (fail closed, matches webhook-receiver.js).
 *
 * Usage (wire into server.js)
 * ─────────────────────────────
 *   import { stripeWebhookRouter } from './engine/billing/stripe-webhook.js';
 *   app.use('/webhooks', stripeWebhookRouter);
 *
 * Routes registered
 * ───────────────────
 *   POST /webhooks/stripe
 */

import express from 'express';
import Stripe from 'stripe';

let _client = null;
function getClient() {
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

// Events that mean money landed. Anything else is acknowledged and ignored.
const PAID_EVENTS = new Set(['checkout.session.completed', 'invoice.paid']);

export const stripeWebhookRouter = express.Router();

// Stripe signature verification needs the exact raw body bytes — same
// pattern as webhook-receiver.js's GitHub/GitLab routes.
stripeWebhookRouter.use(express.raw({ type: 'application/json', limit: '2mb' }));

stripeWebhookRouter.post('/stripe', (req, res) => {
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? '').trim();
  if (!secret) {
    return res.status(401).json({ error: 'STRIPE_WEBHOOK_SECRET is not configured.' });
  }

  let event;
  try {
    event = getClient().webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    return res.status(401).json({ error: `Invalid Stripe webhook signature: ${err.message}` });
  }

  if (PAID_EVENTS.has(event.type)) {
    const obj = event.data.object;
    const tenantId = obj.metadata?.tenantId ?? obj.client_reference_id ?? '(unknown)';
    console.log(`[stripe-webhook] PARTNER PAID — tenant=${tenantId} event=${event.type} id=${event.id}`);
  }

  // Ack everything we understood the signature of, whether or not it was a
  // paid event — Stripe retries on non-2xx.
  res.status(200).json({ received: true });
});
