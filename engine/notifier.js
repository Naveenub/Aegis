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

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort POST with retry/backoff on transient failures (network errors,
// 429, 5xx). Never throws — logs and gives up after MAX_ATTEMPTS.
async function postWithRetry(label, url, body) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
      if (res.status !== 429 && res.status < 500) {
        // non-retryable (4xx other than rate limit) — bail immediately
        process.stderr.write(`[notifier] ${label} delivery failed: HTTP ${res.status}\n`);
        return;
      }
      if (attempt === MAX_ATTEMPTS) {
        process.stderr.write(`[notifier] ${label} delivery failed after ${MAX_ATTEMPTS} attempts: HTTP ${res.status}\n`);
        return;
      }
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        process.stderr.write(`[notifier] ${label} delivery failed after ${MAX_ATTEMPTS} attempts: ${err.message}\n`);
        return;
      }
    }
    await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
  }
}

async function postSlack(text) {
  if (!SLACK_WEBHOOK) return;
  await postWithRetry('Slack', SLACK_WEBHOOK, { text });
}

async function postDiscord(text) {
  if (!DISCORD_WEBHOOK) return;
  await postWithRetry('Discord', DISCORD_WEBHOOK, { content: text });
}
