/**
 * engine/billing/allowance.js
 *
 * Checks tenant usage against their tier's included allowance.
 * This is informational/soft — it does NOT block requests. Overage is a
 * billable event via the existing usage-recorder.js → stripe-reporter.js
 * pipeline, not a forbidden action (that's tenant-quota.js's job).
 *
 * Billing period: calendar month (UTC), matching the reset cadence assumed
 * by Stripe metered subscription items. No proration or custom billing
 * anchors — out of scope for this pass.
 */

import { getUsageInPeriod } from '../usage-recorder.js';
import { getTierConfig } from './tiers.js';
import { getTier } from '../tenant-registry.js';
import { assertTenantId } from '../tenant.js';

function currentPeriodStart() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * @param {string} tenantId
 * @param {string} eventType  - one of usage-recorder.js EVENT_TYPES
 * @returns {Promise<{ tier: string, eventType: string, used: number|null, included: number|null, overage: number }>}
 */
export async function checkAllowance(tenantId, eventType) {
  assertTenantId(tenantId);

  const requestedTier = await getTier(tenantId);
  const config = getTierConfig(requestedTier);
  const included = config.allowance[eventType] ?? 0;

  // null = unlimited (see tiers.js) — no overage is possible, skip the query.
  if (included === null) {
    return { tier: requestedTier ?? 'starter', eventType, used: null, included: null, overage: 0 };
  }

  const used = await getUsageInPeriod(tenantId, eventType, currentPeriodStart());
  const overage = Math.max(0, used - included);

  return { tier: requestedTier ?? 'starter', eventType, used, included, overage };
}
