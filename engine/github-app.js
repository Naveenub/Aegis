/**
 * engine/github-app.js — GitHub App auth (no PATs)
 *
 * Flow
 * ────
 *   1. POST /tenants/:id/repo/connect  → signed `state` + App install URL
 *   2. Customer installs the App, GitHub redirects to /github/callback with
 *      installation_id, state, and an OAuth `code` (enable "Request user
 *      authorization (OAuth) during installation" on the App).
 *   3. We exchange `code` and verify the *user* can see that installation —
 *      otherwise tenant B could submit tenant A's installation_id.
 *   4. Git/PR access uses short-lived installation tokens scoped to the single
 *      selected repository. Nothing long-lived is stored.
 *
 * Env
 * ───
 *   AEGIS_GITHUB_APP_ID, AEGIS_GITHUB_APP_SLUG
 *   AEGIS_GITHUB_APP_PRIVATE_KEY (PEM, "\n" escapes ok) | AEGIS_GITHUB_APP_PRIVATE_KEY_PATH
 *   AEGIS_GITHUB_APP_CLIENT_ID, AEGIS_GITHUB_APP_CLIENT_SECRET
 *   AEGIS_GITHUB_APP_WEBHOOK_SECRET
 *   AEGIS_OAUTH_STATE_SECRET (>= 32 chars)
 *   AEGIS_GITHUB_API_URL / AEGIS_GITHUB_WEB_URL (GitHub Enterprise)
 */

import { createSign, createHmac, timingSafeEqual, randomBytes } from 'crypto';
import fs from 'fs';

const cfg = (k, d = '') => (process.env[k] ?? d).trim();
const apiBase = () => cfg('AEGIS_GITHUB_API_URL', 'https://api.github.com').replace(/\/$/, '');
export const webBase = () => cfg('AEGIS_GITHUB_WEB_URL', 'https://github.com').replace(/\/$/, '');

const b64u = (b) => Buffer.from(b).toString('base64url');

export function githubAppConfigured() {
  return Boolean(
    cfg('AEGIS_GITHUB_APP_ID') && cfg('AEGIS_GITHUB_APP_SLUG') &&
    (cfg('AEGIS_GITHUB_APP_PRIVATE_KEY') || cfg('AEGIS_GITHUB_APP_PRIVATE_KEY_PATH')) &&
    cfg('AEGIS_GITHUB_APP_CLIENT_ID') && cfg('AEGIS_GITHUB_APP_CLIENT_SECRET') &&
    cfg('AEGIS_OAUTH_STATE_SECRET').length >= 32,
  );
}

function privateKey() {
  const inline = cfg('AEGIS_GITHUB_APP_PRIVATE_KEY');
  if (inline) return inline.replace(/\\n/g, '\n');
  return fs.readFileSync(cfg('AEGIS_GITHUB_APP_PRIVATE_KEY_PATH'), 'utf-8');
}

/** RS256 App JWT (10 min max per GitHub). */
export function appJwt(nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg('AEGIS_GITHUB_APP_ID') }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey());
  return `${head}.${body}.${b64u(sig)}`;
}

async function gh(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const e = new Error(`GitHub ${method} ${path} failed (HTTP ${res.status})`);
    e.status = res.status;
    throw e;
  }
  return res.status === 204 ? null : res.json();
}

// ─── Installation tokens ──────────────────────────────────────────────────────

const _tokens = new Map(); // `${installationId}:${repo ?? '*'}` → { token, expiresAt }
const SKEW_MS = 5 * 60_000;

/**
 * Short-lived installation token, scoped to one repo when `repo` is given.
 * In-memory cache only — never persisted.
 */
export async function getInstallationToken(installationId, repo) {
  const key = `${installationId}:${repo ?? '*'}`;
  const hit = _tokens.get(key);
  if (hit && hit.expiresAt - SKEW_MS > Date.now()) return hit.token;

  const body = repo
    ? { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write' } }
    : undefined;
  const data = await gh(`/app/installations/${installationId}/access_tokens`, {
    token: appJwt(), method: 'POST', body,
  });
  _tokens.set(key, { token: data.token, expiresAt: Date.parse(data.expires_at) });
  return data.token;
}

export function forgetInstallation(installationId) {
  for (const k of _tokens.keys()) if (k.startsWith(`${installationId}:`)) _tokens.delete(k);
}

export async function getInstallation(installationId) {
  return gh(`/app/installations/${installationId}`, { token: appJwt() });
}

export async function listInstallationRepos(installationId) {
  const token = await getInstallationToken(installationId);
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const data = await gh(`/installation/repositories?per_page=100&page=${page}`, { token });
    for (const r of data.repositories ?? []) {
      out.push({
        fullName: r.full_name, owner: r.owner.login, name: r.name,
        defaultBranch: r.default_branch, private: r.private, archived: r.archived,
      });
    }
    if ((data.repositories ?? []).length < 100) break;
  }
  return out.filter(r => !r.archived);
}

// ─── Install flow: state + user verification ─────────────────────────────────

function stateSecret() {
  const s = cfg('AEGIS_OAUTH_STATE_SECRET');
  if (s.length < 32) throw new Error('AEGIS_OAUTH_STATE_SECRET must be >= 32 chars.');
  return s;
}

const mac = (payload) => createHmac('sha256', stateSecret()).update(payload).digest('base64url');

export function signState(tenantId, nowMs = Date.now()) {
  const payload = b64u(JSON.stringify({ t: tenantId, n: randomBytes(12).toString('hex'), e: nowMs + 600_000 }));
  return `${payload}.${mac(payload)}`;
}

/** @returns {{ tenantId: string, nonce: string }} @throws on tamper/expiry */
export function verifyState(state, nowMs = Date.now()) {
  const [payload, sig] = String(state ?? '').split('.');
  if (!payload || !sig) throw new Error('Invalid state.');
  const a = Buffer.from(sig), b = Buffer.from(mac(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid state.');
  const { t, n, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (typeof e !== 'number' || e < nowMs) throw new Error('State expired.');
  return { tenantId: t, nonce: n };
}

export function installUrl(state) {
  return `${webBase()}/apps/${cfg('AEGIS_GITHUB_APP_SLUG')}/installations/new?state=${encodeURIComponent(state)}`;
}

/**
 * Confirm the person completing the install can actually see this installation.
 * User token is used once and discarded.
 */
export async function userCanAccessInstallation(code, installationId) {
  if (!code) return false;
  const res = await fetch(`${webBase()}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: cfg('AEGIS_GITHUB_APP_CLIENT_ID'),
      client_secret: cfg('AEGIS_GITHUB_APP_CLIENT_SECRET'),
      code,
    }),
  });
  const tok = res.ok ? (await res.json()).access_token : null;
  if (!tok) return false;

  for (let page = 1; page <= 5; page++) {
    const data = await gh(`/user/installations?per_page=100&page=${page}`, { token: tok });
    if ((data.installations ?? []).some(i => String(i.id) === String(installationId))) return true;
    if ((data.installations ?? []).length < 100) break;
  }
  return false;
}

// ─── Webhook signature ───────────────────────────────────────────────────────

export function verifyAppWebhook(rawBody, sigHeader) {
  const secret = cfg('AEGIS_GITHUB_APP_WEBHOOK_SECRET');
  if (!secret || !sigHeader) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(sigHeader), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
