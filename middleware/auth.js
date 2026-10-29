/**
 * Authentication middleware for Aegis API.
 *
 * Per-tenant key model
 * ────────────────────
 * Each tenant can have multiple API keys managed at runtime via the key-store
 * (engine/key-store.js).  Keys are created, rotated, and revoked through the
 * management API without restarting any process.
 *
 * Resolution order for every request
 * ────────────────────────────────────
 *   1. Redis key-store  — runtime keys (preferred; supports rotation/revocation)
 *   2. AEGIS_API_KEY_{TENANTID} env var  — per-tenant static key (legacy fallback)
 *   3. AEGIS_API_KEY env var             — global static key, default tenant only
 *
 * Env-var keys continue to work so existing deployments need no changes.
 * Operators can migrate one tenant at a time by creating a Redis key and then
 * removing the env var on the next deploy.
 *
 * Key format in requests (unchanged)
 * ────────────────────────────────────
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 *
 * Dashboard sessions (SSO)
 * ────────────────────────
 * A session token ("aegs_…", issued by POST /auth/sso/exchange) travels exactly
 * like an API key — same headers, same ?apiKey= SSE fallback — and resolves to
 * a human user instead of a key. Role and disabled state are read live from
 * the user record on every request.
 *
 * After successful auth:
 *   req.resolvedTenantId  – the tenant the credential authorises
 *   req.resolvedKeyId     – the keyId from the store, or 'env' for static keys
 *                           (undefined for user sessions)
 *   req.actor             – { type: 'user'|'api-key', id, role, email? }
 *
 * Authorisation: put requirePermission('<perm>') after requireApiKey
 * (permissions → minimum role live in engine/rbac.js). Keys created before
 * roles existed, and env-var keys, are 'admin'.
 *
 * Usage (unchanged from before)
 * ──────────────────────────────
 *   import { requireApiKey, optionalApiKey, assertTenantAccess, requirePermission } from './middleware/auth.js';
 *
 *   app.post('/task', (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
 *                     requirePermission('workflow.run'), handler);
 *   app.get('/health', optionalApiKey, handler);
 *   if (!assertTenantAccess(req, tenantId, res)) return;
 */

import { timingSafeEqual } from 'crypto';
import { hashKey, lookupByHash } from '../engine/key-store.js';
import { getStatus } from '../engine/tenant-registry.js';
import { resolveSession, SESSION_PREFIX } from '../engine/user-store.js';
import { can, LEGACY_ROLE, PERMISSIONS } from '../engine/rbac.js';

const GLOBAL_KEY        = process.env.AEGIS_API_KEY ?? '';
const DEFAULT_TENANT_ID = 'default';

if (!GLOBAL_KEY && !Object.keys(process.env).some(k => k.startsWith('AEGIS_API_KEY_'))) {
  console.warn(
    '[auth] WARNING: No static API keys configured. ' +
    'Set AEGIS_API_KEY_{TENANTID} per tenant, or use POST /tenants/:id/keys to create runtime keys. ' +
    'All protected endpoints will reject every request until a key is configured.'
  );
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Billing gate lookup. Returns null when the key may proceed, else the
 * tenant's non-active status ('pending' | 'suspended'). Static env keys are
 * never gated. Throws on a status-store error (callers fail closed).
 */
async function inactiveStatus(resolved) {
  if (resolved.keyId === 'env') return null;
  const status = await getStatus(resolved.tenantId);
  return status === 'active' ? null : status;
}

/**
 * Route-level opt-out of the billing gate, placed BEFORE requireApiKey, for
 * endpoints a pending/suspended tenant must still reach to fix billing
 * (e.g. POST /billing/portal, GET /tenants/:id/billing).
 */
export function allowInactiveTenant(req, _res, next) {
  req.allowInactive = true;
  next();
}

/** Normalise tenantId → env-var suffix: "acme-corp" → "ACME_CORP" */
function tenantEnvSuffix(tenantId) {
  return String(tenantId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Extract raw key from request headers or (as a fallback) the ?apiKey= query
 * parameter.  The query-param fallback is needed only for EventSource / SSE
 * connections — browsers cannot set custom headers on EventSource requests.
 * Header-based auth (Authorization: Bearer or x-api-key) takes priority.
 */
export function extractKey(req) {
  const authHeader = req.headers['authorization'] ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const headerKey = (req.headers['x-api-key'] ?? '').trim();
  if (headerKey) return headerKey;
  // Fallback for SSE: EventSource cannot set headers in browsers
  return (req.query?.apiKey ?? '').trim();
}

/**
 * Constant-time string comparison (timing-safe).
 * Always iterates max(a,b) chars so length differences don't leak.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

/**
 * Resolve env-var static key for a tenant.
 * Returns { key, tenantId } or null when no static key is configured.
 */
function resolveEnvKey(requestedTenantId) {
  const tid = requestedTenantId ?? DEFAULT_TENANT_ID;

  const perTenantKey = process.env[`AEGIS_API_KEY_${tenantEnvSuffix(tid)}`] ?? '';
  if (perTenantKey) return { key: perTenantKey, tenantId: tid };

  if (GLOBAL_KEY && (!requestedTenantId || requestedTenantId === DEFAULT_TENANT_ID)) {
    return { key: GLOBAL_KEY, tenantId: DEFAULT_TENANT_ID };
  }

  return null;
}

/**
 * Core async credential resolution.
 *
 * Session tokens resolve to a user; anything else checks the Redis key-store
 * first (runtime keys), then env vars (static keys).
 * Returns { tenantId, keyId, role, actor } on success or null on failure.
 *
 * @param {string}           provided           - raw key / session token from the request
 * @param {string|undefined} requestedTenantId  - tenant the caller claims to be
 * @returns {Promise<{ tenantId: string, keyId: string|null, role: string,
 *                     actor: { type: string, id: string, role: string, email?: string } }|null>}
 */
async function resolveKey(provided, requestedTenantId) {
  // ── 0. SSO dashboard session ──────────────────────────────────────────────
  if (provided.startsWith(SESSION_PREFIX)) {
    const user = await resolveSession(provided);
    if (!user) return null;
    if (requestedTenantId && requestedTenantId !== user.tenantId) return null;
    return {
      tenantId: user.tenantId, keyId: null, role: user.role,
      actor: { type: 'user', id: user.userId, email: user.email, role: user.role },
    };
  }

  // ── 1. Redis key-store (runtime keys) ─────────────────────────────────────
  const hash   = hashKey(provided);
  const stored = await lookupByHash(hash);

  if (stored) {
    // If the caller declared a tenantId, it must match what the key authorises.
    if (requestedTenantId && requestedTenantId !== stored.tenantId) {
      return null; // key is valid but not for the claimed tenant
    }
    const role = stored.role ?? LEGACY_ROLE;
    return { tenantId: stored.tenantId, keyId: stored.keyId, role, actor: { type: 'api-key', id: stored.keyId, role } };
  }

  // ── 2. Env-var static keys (legacy / bootstrap) ───────────────────────────
  const envEntry = resolveEnvKey(requestedTenantId);
  if (envEntry && safeCompare(provided, envEntry.key)) {
    return {
      tenantId: envEntry.tenantId, keyId: 'env', role: LEGACY_ROLE,
      actor: { type: 'api-key', id: 'env-key', role: LEGACY_ROLE },
    };
  }

  return null;
}

function applyResolved(req, resolved) {
  req.resolvedTenantId = resolved.tenantId;
  req.resolvedKeyId    = resolved.keyId ?? undefined;
  req.actor            = { ...resolved.actor, tenantId: resolved.tenantId };
}

// ─── Exported middleware ───────────────────────────────────────────────────────

/**
 * Middleware: require a valid API key.
 *
 * On success sets req.resolvedTenantId and req.resolvedKeyId, then calls next().
 * On failure sends 401 or 403 and does NOT call next().
 *
 *   app.post('/task', (req, res, next) =>
 *     requireApiKey(req, res, next, req.body?.tenantId));
 */
export async function requireApiKey(req, res, next, ...rest) {
  // Express treats any handler with fn.length > 3 as an ERROR handler and skips
  // it for normal requests, so a bare `app.get(path, requireApiKey, …)` would
  // never run auth. The optional tenant claim therefore rides in a rest
  // parameter (not counted by fn.length) — keep this function at length 3.
  const requestedTenantId = rest[0];
  const provided = extractKey(req);

  if (!provided) {
    return res.status(401).json({
      error: 'Missing API key or session token. Provide Authorization: Bearer <key> or x-api-key: <key>.',
    });
  }

  let resolved;
  try {
    resolved = await resolveKey(provided, requestedTenantId);
  } catch (err) {
    // Redis down, etc. — fail closed
    console.error('[auth] Key resolution error:', err.message);
    return res.status(503).json({ error: 'Authentication service unavailable.' });
  }

  if (!resolved) {
    return res.status(403).json({ error: 'Invalid, revoked or expired credentials.' });
  }

  // Billing gate: signed-up-but-unpaid or payment-failed tenants are blocked.
  if (!req.allowInactive) {
    let blocked;
    try {
      blocked = await inactiveStatus(resolved);
    } catch (err) {
      console.error('[auth] Status check error:', err.message);
      return res.status(503).json({ error: 'Authentication service unavailable.' });
    }
    if (blocked) {
      return res.status(402).json({
        error: blocked === 'pending'
          ? 'Payment required: complete your first payment to activate this account.'
          : 'Account suspended: payment failed or subscription cancelled.',
        status: blocked,
      });
    }
  }

  applyResolved(req, resolved);
  next();
}

/**
 * Middleware: parse the key if present but never block the request.
 * Sets req.authenticated = true/false and req.resolvedTenantId when valid.
 */
export async function optionalApiKey(req, res, next) {
  const provided = extractKey(req);
  if (!provided) {
    req.authenticated = false;
    return next();
  }

  try {
    const resolved = await resolveKey(provided, undefined);
    // Pending/suspended tenants are treated as unauthenticated here.
    if (resolved && !(await inactiveStatus(resolved))) {
      req.authenticated = true;
      applyResolved(req, resolved);
    } else {
      req.authenticated = false;
    }
  } catch {
    req.authenticated = false;
  }

  next();
}

/**
 * Route-handler helper: assert that the request's authenticated tenant matches
 * the tenantId being acted on.
 *
 * Returns true if access is allowed; sends 403 and returns false otherwise.
 *
 *   if (!assertTenantAccess(req, tenantId, res)) return;
 */
export function assertTenantAccess(req, tenantId, res) {
  if (req.resolvedTenantId && req.resolvedTenantId !== tenantId) {
    res.status(403).json({
      error: `API key is not authorised for tenant "${tenantId}".`,
    });
    return false;
  }
  return true;
}

/**
 * Route-level authorisation: place AFTER requireApiKey.
 * Fails closed — no resolved actor, or a role below the permission's minimum, is 403.
 *
 *   app.delete('/x', requireApiKey, requirePermission('key.manage'), handler);
 */
export function requirePermission(permission) {
  if (!PERMISSIONS[permission]) throw new Error(`Unknown permission "${permission}".`);
  return (req, res, next) => {
    if (!can(req.actor?.role, permission)) {
      return res.status(403).json({
        error: `Role "${req.actor?.role ?? 'none'}" cannot perform this action.`,
        permission,
        requiredRole: PERMISSIONS[permission],
      });
    }
    next();
  };
}

/**
 * Identity fields for recordAuditEvent(): spread into the event so every
 * audit entry names the human (or key) behind the request.
 *
 *   recordAuditEvent(tenant, { ...auditActor(req), action, resourceType, resourceId })
 */
export function auditActor(req) {
  const a = req.actor;
  if (!a) return { actorId: req.resolvedKeyId ?? 'env-key', actorType: 'api-key', ip: req.ip };
  return {
    actorId: a.id,
    actorType: a.type,
    actorRole: a.role,
    ...(a.email ? { actorEmail: a.email } : {}),
    ip: req.ip,
  };
}

/**
 * Platform-operator gate (x-admin-key = AEGIS_ADMIN_KEY): cap overrides,
 * manual credit grants, per-tenant SSO config. Not a tenant role — it is the
 * deployment owner's key. Unset = routes disabled (fails closed).
 */
export function requireAdmin(req, res, next) {
  const expected = (process.env.AEGIS_ADMIN_KEY ?? '').trim();
  const given = String(req.headers['x-admin-key'] ?? '');
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Admin key required.' });
  }
  next();
}
