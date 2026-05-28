/**
 * Authentication middleware for Aegis API.
 *
 * Reads the expected key from AEGIS_API_KEY (env var).
 * Callers must send one of:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 *
 * Usage:
 *   import { requireApiKey, optionalApiKey } from './middleware/auth.js';
 *   app.use(requireApiKey);           // protect everything below this line
 *   app.get('/health', optionalApiKey, handler);  // open, but parsed if present
 */

const AEGIS_API_KEY = process.env.AEGIS_API_KEY ?? '';

if (!AEGIS_API_KEY) {
  console.warn(
    '[auth] WARNING: AEGIS_API_KEY is not set. ' +
    'All protected endpoints will reject every request. ' +
    'Set AEGIS_API_KEY in your environment or .env file.'
  );
}

/**
 * Extract the raw key from the request.
 * Accepts:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
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
  if (a.length !== b.length) {
    // Still do a dummy compare to avoid length-based timing leak
    let dummy = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      dummy |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Middleware: require a valid API key.
 * Returns 401 if the key is missing or wrong.
 */
export function requireApiKey(req, res, next) {
  const provided = extractKey(req);

  if (!provided) {
    return res.status(401).json({
      error: 'Missing API key. Provide Authorization: Bearer <key> or x-api-key: <key>.'
    });
  }

  if (!safeCompare(provided, AEGIS_API_KEY)) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

/**
 * Middleware: parse the key if present but never block the request.
 * Useful for endpoints that are intentionally public (e.g. /health)
 * but may want to log authenticated callers differently in the future.
 */
export function optionalApiKey(req, res, next) {
  const provided = extractKey(req);
  req.authenticated = provided ? safeCompare(provided, AEGIS_API_KEY) : false;
  next();
}
