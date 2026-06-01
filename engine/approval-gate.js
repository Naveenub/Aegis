/**
 * approval-gate.js
 *
 * Wires the CLAUDE_AUTONOMY and MODE environment variables that were declared
 * in .env.example but never read by any code.
 *
 * ── Env vars ──────────────────────────────────────────────────────────────────
 *
 *   CLAUDE_AUTONOMY=true   (default)
 *     true  -- autonomous mode: patches are applied without human sign-off
 *     false -- supervised mode: every patch is held for human review before
 *              it is applied; the worker flags the step and returns early
 *
 *   MODE=autonomous        (default)
 *     autonomous -- same as CLAUDE_AUTONOMY=true
 *     approval   -- same as CLAUDE_AUTONOMY=false; individual patches that
 *                   pass all automated checks are still routed to the human
 *                   review queue before being written to disk
 *
 *   Either var is sufficient to engage human-in-the-loop; MODE=approval takes
 *   the same code path as CLAUDE_AUTONOMY=false.  When both are set they are
 *   combined: approval is required if either var requests it.
 *
 * ── Outbound notification ─────────────────────────────────────────────────────
 *
 *   AEGIS_APPROVAL_WEBHOOK   (optional)
 *     When set, a JSON POST is sent to this URL every time a patch is held for
 *     human approval.  Falls back to AEGIS_ALERT_WEBHOOK when the dedicated var
 *     is absent so operators only need one webhook endpoint if they prefer.
 *     When neither is set the notification is written to stderr only.
 *
 *   Payload shape mirrors the DLQ alert envelope:
 *     {
 *       level:       'APPROVAL_REQUIRED',
 *       source:      'aegis-approval-gate',
 *       timestamp:   <ISO string>,
 *       workflowId:  string,
 *       stepId:      string,
 *       reason:      string,
 *       mode:        string,
 *       description: string | undefined,
 *       reviewUrl:   '/review-queue'  (relative hint for the UI)
 *     }
 *
 * ── Worker integration (engine/git.js) ───────────────────────────────────────
 *
 *   After the AI review-guard approves a patch and before applyPatch() is
 *   called, the worker calls:
 *
 *     const gate = needsApproval(step);
 *     if (gate) {
 *       await flagForReview(workflowId, step.id, { ...gate });
 *       await updateStep(workflowId, step.id, 'needs-review');
 *       await notifyApprovalRequired(workflowId, step.id, { ...gate, description: step.description });
 *       return { awaitingApproval: true };
 *     }
 *
 *   Human resolves via:
 *     POST /review/:workflowId/:stepId/resolve  { resolution: 'retrying' }
 *   which re-queues the step.  On the second pass the patch has already been
 *   AI-approved and is idempotency-checked, so it applies immediately.
 *
 * ── Step-level override ───────────────────────────────────────────────────────
 *
 *   A planner step may declare  requiresApproval: true  to force human
 *   sign-off regardless of the global MODE, or  requiresApproval: false
 *   to skip the gate for that step even in approval mode.
 */

import { logger } from './logger.js';

// ── Read env once at module load ──────────────────────────────────────────────

const AUTONOMY_RAW = (process.env.CLAUDE_AUTONOMY ?? 'true').trim().toLowerCase();
const MODE_RAW     = (process.env.MODE            ?? 'autonomous').trim().toLowerCase();

/**
 * True when the global config requires human sign-off on every patch.
 *
 * Approval is active when:
 *   - CLAUDE_AUTONOMY is explicitly "false", OR
 *   - MODE is "approval"
 */
const GLOBAL_APPROVAL_REQUIRED =
  AUTONOMY_RAW === 'false' || MODE_RAW === 'approval';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Decide whether a patch for the given step needs human approval before being
 * applied.
 *
 * @param {object} step  - step object from the planner / workflow store
 * @returns {object|null}
 *   null             -- patch may be applied immediately
 *   { reason, mode } -- patch must be held; pass this object to flagForReview
 */
export function needsApproval(step) {
  // Step-level override takes precedence over the global setting.
  if (step.requiresApproval === false) return null;
  if (step.requiresApproval === true || GLOBAL_APPROVAL_REQUIRED) {
    return {
      reason  : step.requiresApproval === true
        ? 'step explicitly requires human approval'
        : `global MODE="${MODE_RAW}" / CLAUDE_AUTONOMY="${AUTONOMY_RAW}"`,
      mode    : MODE_RAW,
      autonomy: AUTONOMY_RAW,
    };
  }
  return null;
}

/**
 * Whether the system is running in any form of approval mode.
 * Useful for logging / dashboard display.
 */
export const approvalModeActive = GLOBAL_APPROVAL_REQUIRED;

// ── Outbound notification ─────────────────────────────────────────────────────

/**
 * Push a structured notification to stderr and optionally to a webhook whenever
 * a patch is held for human approval.
 *
 * Uses AEGIS_APPROVAL_WEBHOOK when set; falls back to AEGIS_ALERT_WEBHOOK so
 * operators can share a single endpoint with the DLQ alerting if they prefer.
 * When neither is configured the payload is written to stderr only -- the same
 * machine-readable JSON format used by the DLQ worker so it can be piped into
 * PagerDuty, Slack, or any log aggregator.
 *
 * This function never throws; a delivery failure is logged but must not block
 * the worker's return path (the Redis write that flagged the step has already
 * succeeded at this point).
 *
 * @param {string} workflowId
 * @param {string} stepId
 * @param {object} meta   - fields from needsApproval() merged with step context
 *   @param {string} [meta.reason]
 *   @param {string} [meta.mode]
 *   @param {string} [meta.description]
 */
export async function notifyApprovalRequired(workflowId, stepId, meta = {}) {
  const payload = {
    level      : 'APPROVAL_REQUIRED',
    source     : 'aegis-approval-gate',
    timestamp  : new Date().toISOString(),
    workflowId,
    stepId,
    reason     : meta.reason      ?? 'human approval required',
    mode       : meta.mode        ?? MODE_RAW,
    description: meta.description ?? undefined,
    reviewUrl  : '/review-queue',
  };

  // Always write to stderr so log aggregators / process supervisors see it.
  process.stderr.write(JSON.stringify(payload) + '\n');

  // Resolve webhook URL: dedicated var first, shared alert var as fallback.
  const webhookUrl =
    process.env.AEGIS_APPROVAL_WEBHOOK ||
    process.env.AEGIS_ALERT_WEBHOOK    ||
    null;

  if (!webhookUrl) return;

  try {
    const res = await fetch(webhookUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, webhookUrl },
        'Approval-gate webhook returned non-2xx response',
      );
    }
  } catch (err) {
    // Non-fatal -- the review record is already in Redis.
    logger.error(
      { err: err.message, webhookUrl },
      'Approval-gate webhook delivery failed',
    );
  }
}
