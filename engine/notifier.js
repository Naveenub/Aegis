/**
 * engine/notifier.js
 *
 * Slack / Discord delivery for workflow completion + failure events, sent
 * alongside the existing generic AEGIS_ALERT_WEBHOOK / AEGIS_APPROVAL_WEBHOOK
 * alerts (see anomaly-detector.js, approval-gate.js, dlq-worker.js). Both
 * targets are optional and independent — set either, neither, or both.
 *
 * Best-effort, non-blocking: delivery failures are logged to stderr and
 * never propagate, so a broken Slack/Discord endpoint can't affect workflow
 * execution.
 *
 * Env:
 *   AEGIS_SLACK_WEBHOOK    - Slack incoming webhook URL (optional)
 *   AEGIS_DISCORD_WEBHOOK  - Discord webhook URL (optional)
 */

const SLACK_WEBHOOK   = process.env.AEGIS_SLACK_WEBHOOK ?? '';
const DISCORD_WEBHOOK = process.env.AEGIS_DISCORD_WEBHOOK ?? '';

/**
 * Notify Slack/Discord that a workflow reached a terminal state.
 *
 * @param {'completed'|'failed'} status
 * @param {object} ctx
 * @param {string} ctx.workflowId
 * @param {string} [ctx.tenantId]
 * @param {string} ctx.message      - human-readable summary
 */
export async function notifyWorkflowStatus(status, { workflowId, tenantId, message }) {
  if (!SLACK_WEBHOOK && !DISCORD_WEBHOOK) return;

  const emoji = status === 'completed' ? ':white_check_mark:' : ':x:';
  const tenantNote = tenantId ? ` (tenant: ${tenantId})` : '';
  const text = `${emoji} Workflow \`${workflowId}\`${tenantNote} ${status} — ${message}`;

  await Promise.all([postSlack(text), postDiscord(text)]);
}

async function postSlack(text) {
  if (!SLACK_WEBHOOK) return;
  try {
    await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    process.stderr.write(`[notifier] Slack delivery failed: ${err.message}\n`);
  }
}

async function postDiscord(text) {
  if (!DISCORD_WEBHOOK) return;
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
  } catch (err) {
    process.stderr.write(`[notifier] Discord delivery failed: ${err.message}\n`);
  }
}
