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
 */

import { EVENT_TYPES } from '../usage-recorder.js';

export const TIERS = Object.freeze({
  starter: {
    label: 'Starter',
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

export const DEFAULT_TIER = 'starter';

/**
 * @param {string} tier
 * @returns {object} tier config; falls back to DEFAULT_TIER if unknown
 */
export function getTierConfig(tier) {
  return TIERS[tier] ?? TIERS[DEFAULT_TIER];
}
