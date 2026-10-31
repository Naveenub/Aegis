/**
 * engine/trigger-origin.js — Report workflow outcome back to where it was triggered
 *
 * GitHub: comment on the issue (installation token, `issues: write`).
 * Slack:  POST to the slash command's response_url (valid 30 min, host-pinned).
 * Jira:   no write-back (needs per-tenant Jira credentials); see docs.
 *
 * Best-effort: never throws.
 */

import { appJwt } from './github-app.js';
import { saveOrigin, loadOrigin } from './trigger-store.js';

const apiBase = () => (process.env.AEGIS_GITHUB_API_URL ?? 'https://api.github.com').trim().replace(/\/$/, '');
const SLACK_URL = /^https:\/\/hooks\.slack\.com\/(commands|actions)\//;

export { saveOrigin };

const _tok = new Map();
async function issuesToken(installationId, repo) {
  const key = `${installationId}:${repo}`;
  const hit = _tok.get(key);
  if (hit && hit.exp - 300_000 > Date.now()) return hit.token;
  const res = await fetch(`${apiBase()}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ repositories: [repo], permissions: { issues: 'write' } }),
  });
  if (!res.ok) throw new Error(`token HTTP ${res.status}`);
  const d = await res.json();
  _tok.set(key, { token: d.token, exp: Date.parse(d.expires_at) });
  return d.token;
}

export async function commentOnIssue({ installationId, owner, repo, number }, body) {
  const token = await issuesToken(installationId, repo);
  const res = await fetch(`${apiBase()}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: String(body).slice(0, 4000) }),
  });
  if (!res.ok) throw new Error(`comment HTTP ${res.status}`);
}

export async function postSlackResponse(responseUrl, text, inChannel = false) {
  if (!SLACK_URL.test(String(responseUrl ?? ''))) return;
  await fetch(responseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: inChannel ? 'in_channel' : 'ephemeral', text }),
  });
}

/** Deliver a message to an origin object. Swallows all errors. */
export async function sendToOrigin(origin, text) {
  try {
    if (origin?.type === 'github') await commentOnIssue(origin, text);
    else if (origin?.type === 'slack' && origin.expiresAt > Date.now()) await postSlackResponse(origin.responseUrl, text);
  } catch (err) {
    console.warn(`[trigger-origin] ${origin?.type} report failed:`, err.message);
  }
}

/** Called from notifier on workflow terminal states. */
export async function reportToOrigin(workflowId, status, { message, prUrl } = {}) {
  try {
    const origin = await loadOrigin(workflowId);
    if (!origin) return;
    const head = status === 'completed' ? '✅ Aegis finished' : '❌ Aegis failed';
    const text = `${head} (workflow \`${workflowId}\`): ${message ?? status}${prUrl ? `\nPull request: ${prUrl}` : ''}`;
    await sendToOrigin(origin, text);
  } catch (err) {
    console.warn('[trigger-origin] report failed:', err.message);
  }
}
