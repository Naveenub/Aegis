/**
 * engine/billing/tiers.js
 *
 * Pricing tiers: base subscription + included metered allowance.
 * Overage past the included allowance is billed through the existing
 * usage-recorder.js → stripe-reporter.js pipeline (unchanged).
 *
 * `quota` maps to tenant-quota.js limits — the hard, non-billing ceiling
 * enforced regardless of tier (abuse prevention, not a pricing lever).
 * `spend` is the hard LLM-cost ceiling / BYOK entitlement (billing/spend-guard.js).
 * `allowance` maps to usage-recorder.js EVENT_TYPES — the included quantity
 * before Stripe overage billing kicks in.
 * `paid: false` marks a tier with no Stripe subscription (the free tier). Its
 * allowance is a HARD limit, not an overage band — see billing/free-tier.js —
 * because there is nothing to bill overage on.
 */

import { EVENT_TYPES } from '../usage-recorder.js';

export const TIERS = Object.freeze({
  // No card, no Stripe objects. Every number below is PROVISIONAL: the cap and
  // allowances are sized so a free tenant can cost at most `spend.capUsd` of
  // platform-key LLM spend per month, but they have not been checked against
  // measured cost per workflow. Run scripts/measure-cost.js then
  // scripts/propose-pricing.js, which flags any tier whose numbers don't hold.
  free: {
    label: 'Free',
    paid: false,
    quota: { maxActiveWorkflows: 1, maxDailyWorkflows: 3, maxQueuedJobs: 5 },
    spend: { capUsd: 2, byok: false },
    allowance: {
      [EVENT_TYPES.WORKFLOW_RUN]:    25,
      [EVENT_TYPES.AGENT_STEP]:      250,
      [EVENT_TYPES.TOKENS_IN]:       300_000,
      [EVENT_TYPES.TOKENS_OUT]:      40_000,
      [EVENT_TYPES.SANDBOX_MINUTES]: 30,
    },
  },
  starter: {
    label: 'Starter',
    paid: true,
    quota: { maxActiveWorkflows: 3, maxDailyWorkflows: 20, maxQueuedJobs: 50 },
    spend: { capUsd: 15, byok: false },
    allowance: {
      [EVENT_TYPES.WORKFLOW_RUN]:    500,
      [EVENT_TYPES.AGENT_STEP]:      5_000,
      [EVENT_TYPES.TOKENS_IN]:       1_500_000,
      [EVENT_TYPES.TOKENS_OUT]:      300_000,
      [EVENT_TYPES.SANDBOX_MINUTES]: 300,
    },
  },
  pro: {
    label: 'Pro',
    paid: true,
    quota: { maxActiveWorkflows: 10, maxDailyWorkflows: 100, maxQueuedJobs: 200 },
    spend: { capUsd: 150, byok: false },
    allowance: {
      [EVENT_TYPES.WORKFLOW_RUN]:    5_000,
      [EVENT_TYPES.AGENT_STEP]:      50_000,
      [EVENT_TYPES.TOKENS_IN]:       15_000_000,
      [EVENT_TYPES.TOKENS_OUT]:      3_000_000,
      [EVENT_TYPES.SANDBOX_MINUTES]: 3_000,
    },
  },
  enterprise: {
    label: 'Enterprise',
    paid: true,
    quota: { maxActiveWorkflows: 50, maxDailyWorkflows: 1_000, maxQueuedJobs: 2_000 },
    // spend.capUsd: HARD monthly ceiling on platform-key LLM cost (spend-guard.js).
    // Must sit above the included allowance's cost or overage can never be billed.
    // spend.byok: tenant may supply its own Anthropic key (bypasses the platform cap).
    spend: { capUsd: 1_500, byok: true },
    // null = unlimited. (Not Infinity: JSON.stringify silently turns
    // Infinity into null anyway, so this makes the intent explicit instead
    // of accidental.)
    allowance: {
      [EVENT_TYPES.WORKFLOW_RUN]:    null,
      [EVENT_TYPES.AGENT_STEP]:      null,
      [EVENT_TYPES.TOKENS_IN]:       null,
      [EVENT_TYPES.TOKENS_OUT]:      null,
      [EVENT_TYPES.SANDBOX_MINUTES]: null,
    },
  },
});

// Fallback for tenants with no stored tier (design-partner and env-seeded
// tenants). Deliberately NOT 'free': those tenants must never pick up the free
// tier's hard limits by default.
export const DEFAULT_TIER = 'starter';

/** Tier a new visitor lands on in the signup page (config.defaultTier). */
export const SIGNUP_DEFAULT_TIER = 'free';

/** Tiers that have Stripe prices, cheapest first. */
export const PAID_TIERS = Object.freeze(Object.keys(TIERS).filter((t) => TIERS[t].paid));

/** Ordering used to tell an upgrade from a downgrade. */
const TIER_ORDER = Object.freeze(['free', 'starter', 'pro', 'enterprise']);

export function isPaidTier(tier) {
  return TIERS[tier]?.paid === true;
}

/** @returns {number} position in the ladder, -1 if unknown */
export function tierRank(tier) {
  return TIER_ORDER.indexOf(tier);
}

/**
 * @param {string} tier
 * @returns {object} tier config; falls back to DEFAULT_TIER if unknown
 */
export function getTierConfig(tier) {
  return TIERS[tier] ?? TIERS[DEFAULT_TIER];
}
