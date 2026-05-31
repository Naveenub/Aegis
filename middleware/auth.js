/**
 * Authentication middleware for Aegis API.
 *
 * Per-tenant key model
 * ────────────────────
 * Each tenant has its own API key configured via an environment variable:
 *
 *   AEGIS_API_KEY_{TENANTID}=<secret>
 *
 * For example:
 *   AEGIS_API_KEY_DEFAULT=abc123
 *   AEGIS_API_KEY_ACME=xyz789
 *   AEGIS_API_KEY_STAGING=...
 *
 * tenantId is normalised to UPPER_SNAKE_CASE for the env lookup, so tenant
 * "acme-corp" maps to AEGIS_API_KEY_ACME_CORP.
 *
 * A single global fallback key AEGIS_API_KEY (no suffix) is still supported
 * for backwards-compatibility with single-tenant deployments.  When a request
 * presents the global key it is bound to the DEFAULT tenant only.
 *
 * Key resolution order for requireApiKey(tenantId):
 *   1. AEGIS_API_KEY_{TENANTID}  — per-tenant key (preferred)
 *   2. AEGIS_API_KEY             — global key, grants access to "default" only
 *
 * Callers must send the key as one of:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 *
 * After successful auth, req.resolvedTenantId is set to the tenant the key
 * authorises.  Route handlers compare this against any tenantId supplied in
 * the request body / query string and reject mismatches with 403.
 *
 * Usage:
 *   import { requireApiKey, optionalApiKey, assertTenantAccess } from './middleware/auth.js';
 *
 *   // Protect everything below; resolve tenant from body param
 *   app.post('/task', (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId));
 *
 *   // Open endpoint
 *   app.get('/health', optionalApiKey, handler);
 *
 *   // Inside a route handler, enforce tenant match:
 *   assertTenantAccess(req, tenantId, res);  // sends 403 and returns false on mismatch
 */

const GLOBAL_KEY   = process.env.AEGIS_API_KEY ?? '';
const DEFAULT_TENANT_ID = 'default';

if (!GLOBAL_KEY && !Object.keys(process.env).some(k => k.startsWith('AEGIS_API_KEY_'))) {
  console.warn(
    '[auth] WARNING: No API keys configured. ' +
    'Set AEGIS_API_KEY_{TENANTID} per tenant, or AEGIS_API_KEY for single-tenant deployments. ' +
    'All protected endpoints will reject every request until a key is configured.'
  );
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a tenantId to the env-var suffix form.
 * "acme-corp" → "ACME_CORP", "default" → "DEFAULT"
 */
function tenantEnvSuffix(tenantId) {
  return String(tenantId).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Look up the expected key for a tenant.
 * Returns { key, tenantId } where tenantId is the canonical tenant this
 * key authorises, or null if no key is configured.
 *
 * @param {string|undefined} requestedTenantId
 */
function resolveExpectedKey(requestedTenantId) {
  const tid = requestedTenantId ?? DEFAULT_TENANT_ID;

  // 1. Per-tenant key
  const perTenantKey = process.env[`AEGIS_API_KEY_${tenantEnvSuffix(tid)}`] ?? '';
  if (perTenantKey) return { key: perTenantKey, tenantId: tid };

  // 2. Global fallback — only valid for the default tenant
  if (GLOBAL_KEY && (!requestedTenantId || requestedTenantId === DEFAULT_TENANT_ID)) {
    return { key: GLOBAL_KEY, tenantId: DEFAULT_TENANT_ID };
  }

  return null; // no key configured for this tenant
}

/**
 * Extract the raw bearer/api-key value from the request.
 */
function extractKey(req) {
  const authHeader = req.headers['authorization'] ?? '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return (req.headers['x-api-key'] ?? '').trim();
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Always iterate max(a,b) chars so length difference doesn't leak timing.
  const len = Math.max(a.length, b.length);
  let diff = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}

// ─── Exported middleware ───────────────────────────────────────────────────────

/**
 * Middleware: require a valid per-tenant API key.
 *
 * Pass the tenantId the caller is requesting access to so the middleware can
 * look up the correct key.  When tenantId is omitted it defaults to "default".
 *
 *   app.post('/task', (req, res, next) =>
 *     requireApiKey(req, res, next, req.body?.tenantId));
 *
 * On success, sets req.resolvedTenantId to the authorised tenant.
 * On failure, sends 401 or 403 and does NOT call next().
 */
export function requireApiKey(req, res, next, requestedTenantId) {
  const provided = extractKey(req);

  if (!provided) {
    return res.status(401).json({
      error: 'Missing API key. Provide Authorization: Bearer <key> or x-api-key: <key>.',
    });
  }

  const expected = resolveExpectedKey(requestedTenantId);

  if (!expected) {
    // No key is configured for this tenant — treat as unknown tenant (403, not 404,
    // to avoid leaking whether the tenant exists).
    return res.status(403).json({
      error: 'No API key configured for the requested tenant.',
    });
  }

  if (!safeCompare(provided, expected.key)) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  // Bind the authorised tenant to the request so route handlers can enforce it.
  req.resolvedTenantId = expected.tenantId;
  next();
}

/**
 * Middleware: parse the key if present but never block the request.
 * Sets req.authenticated = true/false.
 * Does not set req.resolvedTenantId (open endpoints don't have a tenant context).
 */
export function optionalApiKey(req, res, next) {
  const provided = extractKey(req);
  if (provided) {
    // For optional endpoints we validate against the global key only.
    req.authenticated = GLOBAL_KEY ? safeCompare(provided, GLOBAL_KEY) : false;
  } else {
    req.authenticated = false;
  }
  next();
}

/**
 * Route-handler helper: assert that the request's authenticated tenant matches
 * the tenantId being acted on.
 *
 * Returns true if access is allowed; sends a 403 response and returns false
 * when the caller's key does not cover the requested tenant.
 *
 *   if (!assertTenantAccess(req, tenantId, res)) return;
 *
 * @param {import('express').Request}  req
 * @param {string}                     tenantId   – the tenant being accessed
 * @param {import('express').Response} res
 * @returns {boolean}
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
