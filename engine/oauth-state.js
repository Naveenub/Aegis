/**
 * engine/oauth-state.js — Signed, provider-bound OAuth `state`
 *
 * Same scheme as github-app.js (HMAC-SHA256, 10 min expiry, single-use nonce
 * consumed via repo-store.consumeStateNonce) with one addition: the provider is
 * part of the signed payload, so a state issued for GitLab cannot be replayed
 * at /bitbucket/callback or vice versa.
 *
 * Secret: AEGIS_OAUTH_STATE_SECRET (>= 32 chars) — shared with the GitHub flow.
 */

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

function secret() {
  const s = (process.env.AEGIS_OAUTH_STATE_SECRET ?? '').trim();
  if (s.length < 32) throw new Error('AEGIS_OAUTH_STATE_SECRET must be >= 32 chars.');
  return s;
}

export const oauthStateConfigured = () => (process.env.AEGIS_OAUTH_STATE_SECRET ?? '').trim().length >= 32;

const mac = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');

export function signOAuthState(tenantId, provider, nowMs = Date.now()) {
  const payload = b64u(JSON.stringify({
    t: tenantId, p: provider, n: randomBytes(12).toString('hex'), e: nowMs + 600_000,
  }));
  return `${payload}.${mac(payload)}`;
}

/** @returns {{ tenantId: string, nonce: string }} @throws on tamper / expiry / wrong provider */
export function verifyOAuthState(state, provider, nowMs = Date.now()) {
  const [payload, sig] = String(state ?? '').split('.');
  if (!payload || !sig) throw new Error('Invalid state.');
  const a = Buffer.from(sig), b = Buffer.from(mac(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Invalid state.');
  const { t, p, n, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (p !== provider) throw new Error('Invalid state.');
  if (typeof e !== 'number' || e < nowMs) throw new Error('State expired.');
  return { tenantId: t, nonce: n };
}
