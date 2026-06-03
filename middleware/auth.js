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
 * After successful auth:
 *   req.resolvedTenantId  – the tenant the key authorises
 *   req.resolvedKeyId     – the keyId from the store, or 'env' for static keys
 *
 * Usage (unchanged from before)
 * ──────────────────────────────
 *   import { requireApiKey, optionalApiKey, assertTenantAccess } from './middleware/auth.js';
 *
 *   app.post('/task', (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId));
 *   app.get('/health', optionalApiKey, handler);
 *   if (!assertTenantAccess(req, tenantId, res)) return;
 */

import { hashKey, lookupByHash } from '../engine/key-store.js';

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
function extractKey(req) {
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
 * Core async key resolution.
 *
 * Checks Redis key-store first (runtime keys), then falls back to env vars
 * (static keys).  Returns { tenantId, keyId } on success or null on failure.
 *
 * @param {string}           provided           - raw key from the request
 * @param {string|undefined} requestedTenantId  - tenant the caller claims to be
 * @returns {Promise<{ tenantId: string, keyId: string }|null>}
 */
async function resolveKey(provided, requestedTenantId) {
  // ── 1. Redis key-store (runtime keys) ─────────────────────────────────────
  const hash   = hashKey(provided);
  const stored = await lookupByHash(hash);

  if (stored) {
    // If the caller declared a tenantId, it must match what the key authorises.
    if (requestedTenantId && requestedTenantId !== stored.tenantId) {
      return null; // key is valid but not for the claimed tenant
    }
    return stored; // { tenantId, keyId }
  }

  // ── 2. Env-var static keys (legacy / bootstrap) ───────────────────────────
  const envEntry = resolveEnvKey(requestedTenantId);
  if (envEntry && safeCompare(provided, envEntry.key)) {
    return { tenantId: envEntry.tenantId, keyId: 'env' };
  }

  return null;
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
export async function requireApiKey(req, res, next, requestedTenantId) {
  const provided = extractKey(req);

  if (!provided) {
    return res.status(401).json({
      error: 'Missing API key. Provide Authorization: Bearer <key> or x-api-key: <key>.',
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
    return res.status(403).json({ error: 'Invalid or revoked API key.' });
  }

  req.resolvedTenantId = resolved.tenantId;
  req.resolvedKeyId    = resolved.keyId;
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
    if (resolved) {
      req.authenticated    = true;
      req.resolvedTenantId = resolved.tenantId;
      req.resolvedKeyId    = resolved.keyId;
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
