/**
 * engine/billing/stripe-reporter.js
 *
 * Pushes aggregated, unreported rows from usage-recorder.js to Stripe using
 * Billing Meters (stripe.billing.meterEvents.create). The legacy
 * subscriptionItems.createUsageRecord API was removed in stripe-node v22.
 * Run periodically (cron, k8s CronJob, or `npm run billing:flush`) — see
 * scripts/billing-flush.js.
 *
 * Stripe setup (one-time, per usage dimension):
 *   1. Create a Meter with event_name = METER_EVENT_NAME[eventType] below,
 *      customer mapping key "stripe_customer_id", value key "value",
 *      aggregation "sum".
 *   2. Create a metered recurring Price attached to that Meter and put its id
 *      in STRIPE_PRICE_{WORKFLOW_RUN|AGENT_STEP|TOKENS|SANDBOX_MINUTES}.
 *
 * Each tenant needs a stripe customer id (tenant-registry.js
 * setStripeCustomerId — set automatically by POST /signup). A tenant without
 * one is skipped (not an error); usage stays in Postgres until it is set.
 *
 * Configuration: STRIPE_SECRET_KEY; optional STRIPE_METER_EVENT_{TYPE}
 * overrides for the meter event names.
 */

import Stripe from 'stripe';
import { getUnreportedUsage, markReported, EVENT_TYPES } from '../usage-recorder.js';
import { getStripeCustomerId } from '../tenant-registry.js';
import { logger } from '../logger.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _client;
}

const DEFAULT_METER_EVENT_NAME = {
  [EVENT_TYPES.WORKFLOW_RUN]:    'aegis_workflow_run',
  [EVENT_TYPES.AGENT_STEP]:      'aegis_agent_step',
  [EVENT_TYPES.TOKENS]:          'aegis_tokens',
  [EVENT_TYPES.SANDBOX_MINUTES]: 'aegis_sandbox_minutes',
};

export function meterEventName(eventType) {
  const override = process.env[`STRIPE_METER_EVENT_${eventType.toUpperCase()}`];
  return override || DEFAULT_METER_EVENT_NAME[eventType];
}

function idRange(ids) {
  const big = ids.map((i) => BigInt(i));
  const min = big.reduce((a, b) => (b < a ? b : a));
  const max = big.reduce((a, b) => (b > a ? b : a));
  return `${min}-${max}`;
}

/**
 * Aggregate all unreported usage_events and report each tenant/event_type
 * group to Stripe as one meter event. The event `identifier` is derived from
 * the row-id range, so a retry after a failed markReported() is deduplicated
 * by Stripe instead of double-billed.
 *
 * @returns {Promise<{ reported: number, skipped: number, failed: number }>}
 */
export async function flushUsageToStripe() {
  const groups = await getUnreportedUsage();

  let reported = 0, skipped = 0, failed = 0;
  const timestamp = Math.floor(Date.now() / 1000);

  for (const group of groups) {
    const { tenantId, eventType, quantity, ids } = group;

    const customerId = await getStripeCustomerId(tenantId);
    const eventName = meterEventName(eventType);

    if (!customerId || !eventName) {
      logger.warn(
        { tenantId, eventType },
        '[stripe-reporter] no Stripe customer / meter configured — skipping (usage retained for later flush)'
      );
      skipped++;
      continue;
    }

    try {
      // Meter values are integers; round up so partial usage is never under-billed.
      const identifier = `aegis-${tenantId}-${eventType}-${idRange(ids)}`;
      const event = await getClient().billing.meterEvents.create({
        event_name: eventName,
        identifier,
        timestamp,
        payload: {
          stripe_customer_id: customerId,
          value: String(Math.ceil(quantity)),
        },
      });
      await markReported(ids, event?.identifier ?? identifier);
      reported++;
    } catch (err) {
      logger.error({ err, tenantId, eventType }, '[stripe-reporter] meter event push failed');
      failed++;
    }
  }

  return { reported, skipped, failed };
}
