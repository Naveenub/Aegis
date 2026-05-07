/**
 * retry-policy.js
 *
 * Per-step retry configuration. Steps in the planner output can declare
 * a `retryPolicy` block; everything not specified falls back to DEFAULTS.
 *
 * Supported backoff strategies:
 *   immediate – retry instantly (for transient lock contention etc.)
 *   linear    – fixed delay between attempts
 *   exponential – delay doubles each attempt (default)
 *
 * Escalation agents (used when maxAttempts exceeded):
 *   These are the agent roles defined in agent-runner.js that escalation
 *   should try before giving up and routing to DLQ.
 */

// ─── Built-in policy presets ──────────────────────────────────────────────────

export const RetryPreset = {
  // Default for most steps
  STANDARD: {
    maxAttempts: 3,
    backoff: 'exponential',
    delayMs: 2000,
    escalationAgent: 'debugger',
    fallbackAgent: 'meta-reviewer'
  },

  // For steps that touch external services — more patience
  IO_BOUND: {
    maxAttempts: 5,
    backoff: 'exponential',
    delayMs: 3000,
    escalationAgent: 'debugger',
    fallbackAgent: 'meta-reviewer'
  },

  // For pure code-gen steps — fast fail, no point retrying many times
  CODE_GEN: {
    maxAttempts: 2,
    backoff: 'immediate',
    delayMs: 0,
    escalationAgent: 'refactorer',
    fallbackAgent: 'meta-reviewer'
  },

  // For review/validation steps — single shot, failure = hard block
  REVIEW: {
    maxAttempts: 1,
    backoff: 'immediate',
    delayMs: 0,
    escalationAgent: null, // no escalation — review failures are hard blocks
    fallbackAgent: null
  }
};

const DEFAULTS = RetryPreset.STANDARD;

// ─── Policy resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the effective retry policy for a step.
 * Merges step-level declaration over defaults.
 *
 * @param {object} step - step object from the planner
 * @returns {object} resolved policy
 *
 * @example
 * // Step with no policy → STANDARD defaults
 * resolvePolicy({ id: 'step-1', agent: 'feature-builder' })
 * // → { maxAttempts: 3, backoff: 'exponential', delayMs: 2000, ... }
 *
 * @example
 * // Step using a preset by name
 * resolvePolicy({ id: 'step-2', retryPolicy: 'IO_BOUND' })
 *
 * @example
 * // Step with inline overrides
 * resolvePolicy({ id: 'step-3', retryPolicy: { maxAttempts: 5, delayMs: 1000 } })
 */
export function resolvePolicy(step) {
  const decl = step.retryPolicy;

  // No declaration → defaults
  if (!decl) return { ...DEFAULTS };

  // String preset name
  if (typeof decl === 'string') {
    const preset = RetryPreset[decl.toUpperCase()];
    if (!preset) {
      console.warn(`[retry-policy] Unknown preset "${decl}" for step ${step.id} — using STANDARD`);
      return { ...DEFAULTS };
    }
    return { ...preset };
  }

  // Inline object — merge over defaults
  if (typeof decl === 'object') {
    return { ...DEFAULTS, ...decl };
  }

  return { ...DEFAULTS };
}

// ─── Backoff calculator ───────────────────────────────────────────────────────

/**
 * Calculate how long to wait before the next attempt.
 *
 * @param {object} policy  - resolved retry policy
 * @param {number} attempt - current attempt number (1-based)
 * @returns {number} delay in ms
 */
export function calcDelay(policy, attempt) {
  switch (policy.backoff) {
    case 'immediate':
      return 0;

    case 'linear':
      return policy.delayMs * attempt;

    case 'exponential':
    default:
      // 2s → 4s → 8s → 16s ...  capped at 60s
      return Math.min(policy.delayMs * Math.pow(2, attempt - 1), 60_000);
  }
}

/**
 * Determine which agent to use for a given attempt number.
 *
 * attempt 1        → step's own agent
 * attempt 2        → escalationAgent (e.g. debugger)
 * attempt 3+       → fallbackAgent   (e.g. meta-reviewer)
 *
 * @param {object} step    - original step
 * @param {object} policy  - resolved retry policy
 * @param {number} attempt - current attempt (1-based)
 * @returns {string} agent role name
 */
export function agentForAttempt(step, policy, attempt) {
  if (attempt === 1) return step.agent;
  if (attempt === 2 && policy.escalationAgent) return policy.escalationAgent;
  return policy.fallbackAgent ?? policy.escalationAgent ?? step.agent;
}
