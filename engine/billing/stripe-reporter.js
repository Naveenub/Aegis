/**
 * engine/billing/stripe-reporter.js
 *
 * Pushes aggregated, unreported rows from usage-recorder.js to Stripe's
 * metered-billing Usage Records API (subscriptionItems.createUsageRecord,
 * action: 'increment'). Run periodically (cron, k8s CronJob, or
 * `npm run billing:flush`) — see scripts/billing-flush.js.
 *
 * Each tenant must have a Stripe subscription item per metered dimension,
 * configured via tenant-registry.js setBillingConfig(tenantId, {
 *   workflow_run:    'si_...',
 *   agent_step:      'si_...',
 *   tokens:          'si_...',
 *   sandbox_minutes: 'si_...',
 * }).
 *
 * A tenant with no billing config is skipped (not an error) — usage keeps
 * accumulating in Postgres and will be reported once config is added.
 *
 * Configuration: STRIPE_SECRET_KEY.
 */

import Stripe from 'stripe';
import { getUnreportedUsage, markReported } from '../usage-recorder.js';
import { getBillingConfig } from '../tenant-registry.js';
import { logger } from '../logger.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

/**
 * Aggregate all unreported usage_events and report each tenant/event_type
 * group to Stripe as one incremental usage record.
 *
 * @returns {Promise<{ reported: number, skipped: number, failed: number }>}
 */
export async function flushUsageToStripe() {
  const groups = await getUnreportedUsage();

  let reported = 0, skipped = 0, failed = 0;
  const timestamp = Math.floor(Date.now() / 1000);

  for (const group of groups) {
    const { tenantId, eventType, quantity, ids } = group;

    const config = await getBillingConfig(tenantId);
    const subscriptionItem = config?.[eventType];

    if (!subscriptionItem) {
      logger.warn(
        { tenantId, eventType },
        '[stripe-reporter] no subscription item configured — skipping (usage retained for later flush)'
      );
      skipped++;
      continue;
    }

    try {
      // Stripe usage records take integer quantities; token counts and
      // sandbox-minutes are rounded up so partial usage is never under-billed.
      const record = await getClient().subscriptionItems.createUsageRecord(
        subscriptionItem,
        { quantity: Math.ceil(quantity), timestamp, action: 'increment' }
      );
      await markReported(ids, record.id);
      reported++;
    } catch (err) {
      logger.error({ err, tenantId, eventType }, '[stripe-reporter] usage record push failed');
      failed++;
    }
  }

  return { reported, skipped, failed };
}
