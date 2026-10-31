/**
 * engine/billing/plan-change.js
 *
 * Behind POST /billing/plan. Returns { status, body } for the route to send,
 * like signup.js, so it is unit-testable without HTTP.
 *
 * Who can do what (self-serve tiers are free, starter, pro):
 *
 *   free → starter|pro      new Stripe subscription; the response carries a
 *                           clientSecret to confirm with Stripe.js. The tenant
 *                           stays on the free tier, active, until the paid
 *                           invoice clears (stripe-webhook.js moves the tier).
 *   starter → pro           upgrade now; prorated base difference invoiced.
 *   pro → starter           downgrade at the end of the paid period.
 *   starter|pro → free      cancel at the end of the paid period; the tenant
 *                           then lands on the free tier (not suspended).
 *   same tier               clears a pending downgrade / cancel.
 *
 * Not self-serve: enterprise (sales-led), and tenants with no stored tier or
 * no Stripe customer on a paid tier (design partners, invoiced by hand).
 *
 * The tenant's tier is never written here for a paid change: it moves only
 * when the Stripe webhook confirms it, so what a tenant is allowed to use
 * always matches what Stripe will bill.
 */

import { getTier, getTenant, getStripeCustomerId, setStripeCustomerId } from '../tenant-registry.js';
import { recordAuditEvent } from '../audit-log.js';
import { isPaidTier, tierRank, TIERS } from './tiers.js';
import { SELF_SERVE_TIERS, unsandboxedSignupBlocked, signupBlockedReason } from './signup.js';
import { taxInputError } from './tax.js';
import {
  provisionSubscription, findLiveSubscription, cancelIncompleteSubscriptions,
  upgradeSubscription, scheduleDowngrade, scheduleCancelToFree, keepCurrentPlan,
} from './stripe-customer.js';

const bad = (status, error) => ({ status, body: { error } });

/**
 * @param {{ tenantId: string, tier: string, email?: string }} input
 */
export async function changePlan({ tenantId, tier, email, billingAddress, taxId }) {
  if (typeof tier !== 'string' || !TIERS[tier]) {
    return bad(400, `\`tier\` must be one of: ${SELF_SERVE_TIERS.join(', ')}.`);
  }
  if (!SELF_SERVE_TIERS.includes(tier)) {
    return bad(400, 'Enterprise is sales-led — contact us to change to it.');
  }

  const current = await getTier(tenantId);
  if (!current) {
    return bad(409, 'This tenant is billed manually. Contact us to change plan.');
  }
  if (current === 'enterprise') {
    return bad(409, 'Enterprise plans are changed through your account contact.');
  }

  const customerId = await getStripeCustomerId(tenantId);

  // ── free → paid ────────────────────────────────────────────────────────────
  if (current === 'free') {
    if (!isPaidTier(tier)) return { status: 200, body: { tenantId, currentTier: 'free', targetTier: 'free', effective: 'now', effectiveAt: null } };

    // A paid plan runs tenant code on shared infra, same gate as paid signup.
    if (unsandboxedSignupBlocked()) return bad(503, signupBlockedReason());

    // Signup stores the email; fall back to the request body for older tenants.
    if (!customerId) {
      email = (await getTenant(tenantId))?.email ?? email;
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return bad(400, '`email` is required to upgrade from the free plan.');
      }
    }
    const taxError = taxInputError({ address: billingAddress, taxId });
    if (taxError) return bad(400, taxError);
    try {
      if (customerId) await cancelIncompleteSubscriptions(customerId);
      const sub = await provisionSubscription({ email, tenantId, tier, customerId, billingAddress, taxId });
      if (!customerId) await setStripeCustomerId(tenantId, sub.customerId);
      recordAuditEvent(tenantId, {
        actorId: tenantId, action: 'tenant.plan_change', resourceType: 'tenant', resourceId: tenantId,
        detail: { from: 'free', to: tier, effective: 'on_payment' },
      }).catch((err) => console.error('[audit] tenant.plan_change', err));
      return {
        status: 202,
        body: {
          tenantId, currentTier: 'free', targetTier: tier, effective: 'on_payment', effectiveAt: null,
          // Confirm with Stripe.js; the tier changes when the invoice is paid.
          clientSecret: sub.clientSecret,
          stripeSubscriptionId: sub.subscriptionId,
        },
      };
    } catch (err) {
      console.error('[plan-change] free→paid failed', err);
      return bad(502, `Billing provisioning failed: ${err.message}`);
    }
  }

  // ── paid → anything ────────────────────────────────────────────────────────
  if (!customerId) return bad(409, 'No Stripe customer on file for this tenant. Contact us to change plan.');

  try {
    const sub = await findLiveSubscription(customerId);
    if (!sub) return bad(409, 'No active subscription found. Use POST /billing/portal to fix billing first.');

    let result;
    if (tier === current) result = await keepCurrentPlan({ sub, tier });
    else if (tier === 'free') result = await scheduleCancelToFree({ sub });
    else if (tierRank(tier) > tierRank(current)) result = await upgradeSubscription({ sub, tier });
    else result = await scheduleDowngrade({ sub, fromTier: current, tier });

    recordAuditEvent(tenantId, {
      actorId: tenantId, action: 'tenant.plan_change', resourceType: 'tenant', resourceId: tenantId,
      detail: { from: current, to: tier, effective: result.effective },
    }).catch((err) => console.error('[audit] tenant.plan_change', err));

    // For an upgrade the stored tier follows the paid invoice via the webhook,
    // so `currentTier` is what the tenant runs on right now, `targetTier` is
    // where it is headed.
    return {
      status: 200,
      body: { tenantId, currentTier: current, targetTier: tier, effective: result.effective, effectiveAt: result.effectiveAt },
    };
  } catch (err) {
    console.error('[plan-change] failed', err);
    return bad(502, `Plan change failed: ${err.message}`);
  }
}
