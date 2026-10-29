/**
 * engine/billing/free-tier.js
 *
 * Hard limits for the free tier. Paid tiers treat `allowance` as the free band
 * of a graduated Stripe price, so exceeding it just bills overage and
 * allowance.js stays informational. A free tenant has no subscription, so
 * there is nothing to bill: the allowance has to be enforced.
 *
 *   tokens_in / tokens_out / agent_step   bounded by spend-guard.js (tier cap)
 *   workflow_run / sandbox_minutes        checked here, at workflow admission
 *
 * Only applies when the tenant's STORED tier is 'free'. Tenants with no stored
 * tier (design partners, env-seeded) fall back to DEFAULT_TIER elsewhere and
 * are never limited here.
 *
 * Fails closed: if usage cannot be read, a free tenant cannot start a workflow.
 * A workflow already running can still overshoot sandbox minutes by its own
 * duration; that is bounded by the workflow timeout.
 */

import { getTier } from '../tenant-registry.js';
import { EVENT_TYPES } from '../usage-recorder.js';
import { QuotaExceededError } from '../tenant-quota.js';
import { checkAllowance } from './allowance.js';
import { assertTenantId } from '../tenant.js';

export const FREE_HARD_LIMIT_EVENTS = Object.freeze([
  EVENT_TYPES.WORKFLOW_RUN,
  EVENT_TYPES.SANDBOX_MINUTES,
]);

const LABEL = {
  [EVENT_TYPES.WORKFLOW_RUN]: 'workflow runs',
  [EVENT_TYPES.SANDBOX_MINUTES]: 'sandbox minutes',
};

/**
 * @param {string} tenantId
 * @throws {QuotaExceededError} dimension `freeTier:<event>` when a monthly limit is used up
 */
export async function assertFreeTierLimits(tenantId) {
  assertTenantId(tenantId);
  if ((await getTier(tenantId)) !== 'free') return;

  for (const eventType of FREE_HARD_LIMIT_EVENTS) {
    const { used, included } = await checkAllowance(tenantId, eventType);
    if (included !== null && used >= included) {
      throw new QuotaExceededError(
        `Free plan limit reached: ${Math.floor(used)}/${included} ${LABEL[eventType]} this month. ` +
        'Upgrade with POST /billing/plan, or wait for the UTC month reset.',
        { dimension: `freeTier:${eventType}`, current: used, limit: included }
      );
    }
  }
}
