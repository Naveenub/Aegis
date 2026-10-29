/**
 * engine/billing/stripe-webhook.js
 *
 * Inbound Stripe webhook — verifies the signature, then:
 *   invoice.paid                     → tenant status 'active'
 *   invoice.payment_failed           → tenant status 'suspended'
 *   customer.subscription.deleted    → tenant status 'suspended'
 *   customer.subscription.updated    → active/trialing → 'active';
 *                                      past_due/unpaid/canceled → 'suspended'
 *   checkout.session.completed       → metadata.kind=credit_topup: add prepaid credits;
 *                                      otherwise log only (manual Payment Link flow)
 *   invoice.paid (amount_paid > 0)   → also stamps firstPaidAt (lifts unverified spend cap)
 * Plan changes: the tier is stamped on the subscription metadata (`tier`) by
 * stripe-customer.js. When a paid invoice / active subscription carries a
 * different tier than the tenant has, the tenant (and its quota) moves to it —
 * that is how free→paid upgrades, immediate upgrades and period-end downgrades
 * (subscription-schedule phase metadata) take effect. A subscription deleted
 * with metadata.downgradeTo='free' puts the tenant on the free tier, active.
 * A free tenant is never suspended by a lapsed upgrade attempt.
 * The tenant is resolved from metadata.tenantId (set on the subscription by
 * stripe-customer.js). Events with no resolvable, registered tenant are
 * logged and acknowledged without changing anything, so manual design-partner
 * invoices are unaffected. Status changes are idempotent; a failed write
 * returns 500 so Stripe retries.
 *
 * Environment variables
 * ──────────────────────
 *   STRIPE_SECRET_KEY      Required — same client used by stripe-customer.js.
 *   STRIPE_WEBHOOK_SECRET  Required — signing secret from the Stripe webhook
 *                          endpoint settings page. No secret = every request
 *                          rejected (fail closed, matches webhook-receiver.js).
 *
 * Subscribe the endpoint to: checkout.session.completed, invoice.paid,
 * invoice.payment_failed, customer.subscription.deleted,
 * customer.subscription.updated.
 *
 * Routes registered
 * ───────────────────
 *   POST /webhooks/stripe
 */

import express from 'express';
import Stripe from 'stripe';
import { getTenant, setStatus, markFirstPaid, getTier, setTier } from '../tenant-registry.js';
import { setQuota } from '../tenant-quota.js';
import { getTierConfig, isPaidTier } from './tiers.js';
import { addCredits } from './spend-guard.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

// event type -> tenant status to apply (null = log only)
const STATUS_BY_EVENT = {
  'checkout.session.completed':    null,
  'invoice.paid':                  'active',
  'invoice.payment_failed':        'suspended',
  'customer.subscription.deleted': 'suspended',
  // Status derived from the subscription itself — see subscriptionStatus().
  'customer.subscription.updated': 'derived',
};

// active/trialing → active; past_due/unpaid/canceled/incomplete_expired →
// suspended; incomplete/paused → no change (null).
function subscriptionStatus(sub) {
  switch (sub.status) {
    case 'active':
    case 'trialing': return 'active';
    case 'past_due':
    case 'unpaid':
    case 'canceled':
    case 'incomplete_expired': return 'suspended';
    default: return null;
  }
}

function resolveTenantId(obj) {
  return (
    obj.metadata?.tenantId ??
    obj.parent?.subscription_details?.metadata?.tenantId ??   // invoices (current API)
    obj.subscription_details?.metadata?.tenantId ??           // invoices (older API)
    obj.client_reference_id ??
    null
  );
}

function resolveTier(obj) {
  return (
    obj.metadata?.tier ??
    obj.parent?.subscription_details?.metadata?.tier ??   // invoices (current API)
    obj.subscription_details?.metadata?.tier ??           // invoices (older API)
    null
  );
}

/** Move a tenant to a tier (and its quota). No-op if already there. */
async function applyTier(tenantId, tier) {
  if ((await getTier(tenantId)) === tier) return false;
  await setTier(tenantId, tier);
  await setQuota(tenantId, getTierConfig(tier).quota);
  console.log(`[stripe-webhook] tenant=${tenantId} tier=${tier}`);
  return true;
}

export const stripeWebhookRouter = express.Router();

// Stripe signature verification needs the exact raw body bytes — same
// pattern as webhook-receiver.js's GitHub/GitLab routes.
stripeWebhookRouter.use(express.raw({ type: 'application/json', limit: '2mb' }));

stripeWebhookRouter.post('/stripe', async (req, res) => {
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

  if (event.type in STATUS_BY_EVENT) {
    const tenantId = resolveTenantId(event.data.object);
    const mapped = STATUS_BY_EVENT[event.type];
    const status = mapped === 'derived' ? subscriptionStatus(event.data.object) : mapped;
    console.log(`[stripe-webhook] ${event.type} tenant=${tenantId ?? '(unknown)'} id=${event.id}`);

    const obj = event.data.object;
    const downgradeToFree =
      event.type === 'customer.subscription.deleted' && obj.metadata?.downgradeTo === 'free';

    if ((status || downgradeToFree) && tenantId) {
      try {
        if (await getTenant(tenantId)) {
          if (downgradeToFree) {
            // Scheduled paid → free: keep the tenant working on the free tier.
            await applyTier(tenantId, 'free');
            await setStatus(tenantId, 'active');
          } else if (status === 'suspended' && (await getTier(tenantId)) === 'free') {
            // A free tenant has no paid subscription to lapse; this is a
            // cancelled or expired upgrade attempt. Leave the account alone.
            console.log(`[stripe-webhook] tenant=${tenantId} is free — ignoring ${event.type}`);
          } else {
            await setStatus(tenantId, status);
            if (status === 'active') {
              const tier = resolveTier(obj);
              if (isPaidTier(tier)) await applyTier(tenantId, tier);
            }
            // First real payment lifts the unverified spend cap (spend-guard.js).
            // amount_paid > 0 so a $0 trial invoice does not count.
            if (event.type === 'invoice.paid' && obj.amount_paid > 0) {
              await markFirstPaid(tenantId);
            }
            console.log(`[stripe-webhook] tenant=${tenantId} status=${status}`);
          }
        }
      } catch (err) {
        console.error('[stripe-webhook] status update failed', err);
        return res.status(500).json({ error: 'Status update failed; retry.' });
      }
    }
  }

  // Prepaid credit top-up (engine/billing/credits.js Checkout session).
  // Credits granted = amount actually paid; idempotent on the Stripe event id.
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    if (s.metadata?.kind === 'credit_topup' && s.payment_status === 'paid' && s.currency === 'usd') {
      const tenantId = resolveTenantId(s);
      try {
        if (tenantId && (await getTenant(tenantId)) && s.amount_total > 0) {
          await addCredits(tenantId, s.amount_total / 100, event.id);
          console.log(`[stripe-webhook] credit top-up tenant=${tenantId} usd=${s.amount_total / 100}`);
        }
      } catch (err) {
        console.error('[stripe-webhook] credit top-up failed', err);
        return res.status(500).json({ error: 'Credit top-up failed; retry.' });
      }
    }
  }

  // Ack everything we verified the signature of — Stripe retries on non-2xx.
  res.status(200).json({ received: true });
});
