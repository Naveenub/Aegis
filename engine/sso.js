/**
 * engine/sso.js — per-tenant OpenID Connect sign-in (authorization code + PKCE)
 *
 * Works with any OIDC provider (Okta, Entra ID, Google Workspace, Auth0,
 * Keycloak, …). SAML is not supported; front it with an OIDC bridge.
 *
 * Config is per tenant and set by the platform operator (see PUT
 * /tenants/:id/sso). The client secret is sealed with token-vault.js.
 *
 *   aegis:sso:{tenantId}          String  JSON config, clientSecret sealed
 *   aegis:sso-txn:{sha256(state)} String  JSON({ tenantId, nonce, verifier }), 10 min, single-use
 *
 * Who may sign in
 * ───────────────
 *  • A user already provisioned for the tenant (POST /tenants/:id/users) keeps
 *    the role they were given. The first login binds the IdP `sub` to the
 *    user; later logins must present the same `sub` (an email re-assigned at
 *    the IdP cannot take over the account).
 *  • An unknown email is auto-provisioned only when `jitRole` is set AND its
 *    domain is in `allowedDomains`. JIT never grants `admin`.
 *  • When `allowedDomains` is non-empty it is enforced for every login.
 *
 * Login CSRF: the state is also held in a short-lived HttpOnly cookie by the
 * route layer and must match on callback.
 *
 * ponytail: operator-only config (no tenant-supplied issuer URL, so no SSRF
 * surface) – upgrade to self-serve when fetches go through an SSRF-safe agent.
 * ponytail: no IdP group → role mapping – add when a customer needs it.
 */

import { createHash, randomBytes } from 'crypto';
import IORedis from 'ioredis';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { assertTenantId } from './tenant.js';
import { seal, open } from './token-vault.js';
import { isRole } from './rbac.js';
import { createUser, getUserByEmail, updateUser } from './user-store.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

const CFG = (t) => `aegis:sso:${t}`;
const TXN = (s) => `aegis:sso-txn:${createHash('sha256').update(s).digest('hex')}`;
const aad = (t) => `${t}:sso`;
const SIGNING_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512'];

export class SsoError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.code = code;
    Object.assign(this, extra);
  }
}

// ─── Config ─────────────────────────────────────────────────────────────────

function validIssuer(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('`issuer` must be a URL.'); }
  const devLocal = process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(devLocal && u.protocol === 'http:')) throw new Error('`issuer` must be https.');
  return u.toString().replace(/\/$/, '');
}

/**
 * Create or update a tenant's SSO config. Omit `clientSecret` on update to keep the stored one.
 * @param {{ issuer: string, clientId: string, clientSecret?: string,
 *           allowedDomains?: string[], jitRole?: string|null, enabled?: boolean }} cfg
 */
export async function setSsoConfig(tenantId, cfg = {}) {
  assertTenantId(tenantId);
  const prev = await loadRaw(tenantId);

  const issuer = validIssuer(cfg.issuer);
  const clientId = String(cfg.clientId ?? '').trim();
  if (!clientId) throw new Error('`clientId` is required.');

  const allowedDomains = (cfg.allowedDomains ?? []).map((d) => String(d).trim().toLowerCase());
  if (allowedDomains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new Error('`allowedDomains` must be domain names.');

  const jitRole = cfg.jitRole ?? null;
  if (jitRole !== null) {
    if (!isRole(jitRole)) throw new Error(`Invalid jitRole "${jitRole}".`);
    if (jitRole === 'admin') throw new Error('jitRole cannot be "admin"; provision admins explicitly.');
    if (!allowedDomains.length) throw new Error('jitRole requires at least one allowedDomains entry.');
  }

  let clientSecret = prev?.clientSecret;
  if (cfg.clientSecret) clientSecret = seal(String(cfg.clientSecret), aad(tenantId));
  if (!clientSecret) throw new Error('`clientSecret` is required.');

  const record = { issuer, clientId, clientSecret, allowedDomains, jitRole, enabled: cfg.enabled !== false, updatedAt: Date.now() };
  await redis.set(CFG(tenantId), JSON.stringify(record));
  return publicView(record);
}

const publicView = ({ clientSecret: _s, ...rest }) => ({ ...rest, hasSecret: true });

async function loadRaw(tenantId) {
  const raw = await redis.get(CFG(tenantId));
  return raw ? JSON.parse(raw) : null;
}

export async function getSsoConfig(tenantId) {
  assertTenantId(tenantId);
  const c = await loadRaw(tenantId);
  return c ? publicView(c) : null;
}

export async function deleteSsoConfig(tenantId) {
  assertTenantId(tenantId);
  await redis.del(CFG(tenantId));
}

// ─── OIDC plumbing ──────────────────────────────────────────────────────────

const discoCache = new Map(); // issuer → { doc, at }
const jwksCache  = new Map(); // jwks_uri → remote key set

async function discover(issuer) {
  const hit = discoCache.get(issuer);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.doc;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new SsoError('discovery_failed', `Discovery returned ${res.status}`);
  const doc = await res.json();
  if (doc.issuer !== issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new SsoError('discovery_failed', 'Discovery document does not match the configured issuer.');
  }
  discoCache.set(issuer, { doc, at: Date.now() });
  return doc;
}

function redirectUri() {
  const base = (process.env.AEGIS_PUBLIC_URL ?? '').trim().replace(/\/$/, '');
  if (!base) throw new SsoError('not_configured', 'AEGIS_PUBLIC_URL is not set.');
  return `${base}/auth/sso/callback`;
}

// ─── Login flow ─────────────────────────────────────────────────────────────

/** @returns {Promise<{ url: string, state: string }>} send the browser to `url`; keep `state` in a cookie. */
export async function beginLogin(tenantId) {
  assertTenantId(tenantId);
  const cfg = await loadRaw(tenantId);
  if (!cfg?.enabled) throw new SsoError('not_configured', 'SSO is not enabled for this tenant.');
  const disco = await discover(cfg.issuer);

  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await redis.set(TXN(state), JSON.stringify({ tenantId, nonce, verifier }), 'EX', 600);

  const url = new URL(disco.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    scope: 'openid email profile',
    state, nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), state };
}

/**
 * Finish the flow: validate state, redeem the code, verify the ID token, and
 * resolve (or JIT-provision) the user.
 * @returns {Promise<{ user: object, tenantId: string }>}
 * @throws {SsoError} code ∈ state_mismatch | state_expired | not_configured |
 *         token_exchange_failed | invalid_id_token | denied
 */
export async function completeLogin({ code, state, cookieState }) {
  if (!code || !state || state !== cookieState) throw new SsoError('state_mismatch');
  const txnRaw = await redis.getdel(TXN(state)); // single-use
  if (!txnRaw) throw new SsoError('state_expired');
  const { tenantId, nonce, verifier } = JSON.parse(txnRaw);

  const cfg = await loadRaw(tenantId);
  if (!cfg?.enabled) throw new SsoError('not_configured');
  const disco = await discover(cfg.issuer);

  const tokenRes = await fetch(disco.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
      client_id: cfg.clientId, client_secret: open(cfg.clientSecret, aad(tenantId)), code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const tokens = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokens.id_token) {
    throw new SsoError('token_exchange_failed', `Token endpoint returned ${tokenRes.status}`);
  }

  let claims;
  try {
    if (!jwksCache.has(disco.jwks_uri)) jwksCache.set(disco.jwks_uri, createRemoteJWKSet(new URL(disco.jwks_uri), { timeoutDuration: 5000 }));
    ({ payload: claims } = await jwtVerify(tokens.id_token, jwksCache.get(disco.jwks_uri), {
      issuer: cfg.issuer, audience: cfg.clientId, algorithms: SIGNING_ALGS,
    }));
  } catch (err) {
    throw new SsoError('invalid_id_token', err.message);
  }
  if (claims.nonce !== nonce) throw new SsoError('invalid_id_token', 'nonce mismatch');

  const email = String(claims.email ?? '').trim().toLowerCase();
  const denied = (why) => new SsoError('denied', why, { tenantId, email: email || null });
  if (!email || claims.email_verified === false) throw denied('email missing or unverified');
  if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(email.split('@')[1])) throw denied('email domain not allowed');

  let user = await getUserByEmail(tenantId, email);
  if (user) {
    if (user.disabledAt) throw denied('user disabled');
    if (user.idpSub && user.idpSub !== claims.sub) throw denied('idp subject mismatch');
  } else if (cfg.jitRole) {
    user = await createUser(tenantId, {
      email, name: claims.name ?? '', role: cfg.jitRole, idpSub: claims.sub, createdBy: { type: 'sso' },
    });
  } else {
    throw denied('no provisioned user');
  }

  user = await updateUser(tenantId, user.userId, { idpSub: user.idpSub ?? claims.sub, lastLoginAt: Date.now() });
  return { user, tenantId };
}
