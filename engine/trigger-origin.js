/**
 * engine/trigger-origin.js — Report workflow outcome back to where it was triggered
 *
 * GitHub: comment on the issue (installation token, `issues: write`). A missing
 *         permission is recorded (GET /tenants/:id/triggers → lastOriginProblem).
 * Slack:  chat.postMessage with the tenant's bot token (no expiry) when the
 *         workspace was installed via OAuth; otherwise the slash command's
 *         response_url (valid 30 min, host-pinned).
 * Jira:   issue comment via per-tenant credentials (Atlassian-hosted only, or
 *         hosts listed in AEGIS_JIRA_ALLOWED_HOSTS).
 *
 * Best-effort: never throws.
 */

import { appJwt } from './github-app.js';
import {
  saveOrigin, loadOrigin, loadSlackBotToken, loadJiraCreds, noteOriginProblem, clearOriginProblem,
} from './trigger-store.js';

const apiBase = () => (process.env.AEGIS_GITHUB_API_URL ?? 'https://api.github.com').trim().replace(/\/$/, '');
const SLACK_URL = /^https:\/\/hooks\.slack\.com\/(commands|actions)\//;
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export { saveOrigin };

// ─── GitHub ──────────────────────────────────────────────────────────────────

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
  if (!res.ok) { const e = new Error(`token HTTP ${res.status}`); e.status = res.status; throw e; }
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
  if (!res.ok) { const e = new Error(`comment HTTP ${res.status}`); e.status = res.status; throw e; }
}

/**
 * What the installation has actually been granted for Issues.
 * `issues` events (the label trigger) need at least read; status comments need write.
 * @returns {Promise<{ issues: 'write'|'read'|'missing'|'unknown', settingsUrl?: string }>}
 */
export async function installationIssuesPermission(installationId) {
  try {
    const res = await fetch(`${apiBase()}/app/installations/${installationId}`, {
      headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return { issues: 'unknown' };
    const d = await res.json();
    const lvl = d.permissions?.issues;
    return { issues: lvl === 'write' ? 'write' : lvl === 'read' ? 'read' : 'missing', settingsUrl: d.html_url };
  } catch { return { issues: 'unknown' }; }
}

// ─── Slack ───────────────────────────────────────────────────────────────────

export async function postSlackResponse(responseUrl, text, inChannel = false) {
  if (!SLACK_URL.test(String(responseUrl ?? ''))) return false;
  const res = await fetch(responseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: inChannel ? 'in_channel' : 'ephemeral', text }),
  });
  return res.ok;
}

export async function postSlackMessage(token, channel, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ channel, text }),
  });
  const d = await res.json().catch(() => ({}));
  return d.ok === true;
}

async function sendSlack(origin, text) {
  const token = origin.tenantId ? await loadSlackBotToken(origin.tenantId).catch(() => null) : null;
  if (token && origin.channelId && await postSlackMessage(token, origin.channelId, text)) return;
  if (origin.expiresAt > Date.now()) await postSlackResponse(origin.responseUrl, text);
}

// ─── Jira ────────────────────────────────────────────────────────────────────

/**
 * SSRF guard for tenant-supplied Jira URLs: https only, no userinfo/port,
 * host must be *.atlassian.net or listed in AEGIS_JIRA_ALLOWED_HOSTS (self-hosted).
 * @returns {string} normalised origin
 */
export function assertJiraBaseUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('`baseUrl` must be a valid URL.'); }
  const allowed = (process.env.AEGIS_JIRA_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port) throw new Error('`baseUrl` must be https, without credentials or port.');
  if (!(host.endsWith('.atlassian.net') || allowed.includes(host))) {
    throw new Error('`baseUrl` host must be *.atlassian.net or listed in AEGIS_JIRA_ALLOWED_HOSTS.');
  }
  return u.origin;
}

export async function commentOnJira({ tenantId, key }, text) {
  if (!JIRA_KEY.test(String(key))) throw new Error('bad issue key');
  const creds = await loadJiraCreds(tenantId);
  if (!creds) return false;
  const base = assertJiraBaseUrl(creds.baseUrl);
  const res = await fetch(`${base}/rest/api/3/issue/${key}/comment`, {
    method: 'POST', redirect: 'error',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64')}`,
      'Content-Type': 'application/json', Accept: 'application/json',
    },
    body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(text).slice(0, 4000) }] }] } }),
  });
  if (!res.ok) { const e = new Error(`jira comment HTTP ${res.status}`); e.status = res.status; throw e; }
  return true;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/** Deliver a message to an origin object. Swallows all errors. */
export async function sendToOrigin(origin, text) {
  try {
    if (origin?.type === 'github') {
      try {
        await commentOnIssue(origin, text);
        if (origin.tenantId) await clearOriginProblem(origin.tenantId, 'github-comment');
      } catch (err) {
        if (origin.tenantId && [401, 403, 404, 422].includes(err.status)) {
          await noteOriginProblem(origin.tenantId, 'github-comment',
            `Could not comment on issues (HTTP ${err.status}). Accept the "Issues: write" permission on the GitHub App installation.`);
        }
        throw err;
      }
    } else if (origin?.type === 'slack') {
      await sendSlack(origin, text);
    } else if (origin?.type === 'jira') {
      try {
        await commentOnJira(origin, text);
      } catch (err) {
        if (origin.tenantId && [401, 403].includes(err.status)) {
          await noteOriginProblem(origin.tenantId, 'jira-comment', `Jira rejected the credentials or permission (HTTP ${err.status}).`);
        }
        throw err;
      }
    }
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
    const text = `${head} (workflow ${workflowId}): ${message ?? status}${prUrl ? `\nPull request: ${prUrl}` : ''}`;
    await sendToOrigin(origin, text);
  } catch (err) {
    console.warn('[trigger-origin] report failed:', err.message);
  }
}
