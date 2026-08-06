/**
 * Per-tenant rate limiting for Aegis API.
 *
 * Strategy:
 *   - Window and max are configurable via env vars so ops can tune without
 *     a code change.
 *   - The key function uses the resolved tenantId from the request body when
 *     present, falling back to the raw API key so single-tenant deployments
 *     are throttled the same way.
 *   - A second, tighter limiter (`burstLimiter`) caps short-burst abuse
 *     (e.g. 20 req in 5 s) independently of the rolling window.
 *   - Counters are stored in Redis via rate-limit-redis so all workers in a
 *     multi-process deployment share the same counters — a tenant cannot
 *     exceed limits by fan-out across N workers.
 *   - If Redis is unreachable at startup the limiters fall back to in-process
 *     memory with a console warning, preserving availability at the cost of
 *     per-process (not global) enforcement.
 *
 * Environment variables (all optional – sensible defaults shown):
 *   RATE_LIMIT_WINDOW_MS   Rolling window in milliseconds   (default: 60 000)
 *   RATE_LIMIT_MAX         Max requests per window          (default: 60)
 *   RATE_LIMIT_BURST_MS    Burst window in milliseconds     (default: 5 000)
 *   RATE_LIMIT_BURST_MAX   Max requests in burst window     (default: 20)
 *   REDIS_URL              Redis connection URL              (default: redis://127.0.0.1:6379)
 *
 * Usage in server.js:
 *   import { taskRateLimiter } from './middleware/rate-limit.js';
 *   app.post('/task', taskRateLimiter, async (req, res) => { … });
 */

import rateLimit   from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import IORedis      from 'ioredis';

// ─── helpers ──────────────────────────────────────────────────────────────────

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Derive a stable throttle key for the request.
 *
 * Priority:
 *   1. tenantId in JSON body   – gives per-tenant isolation in multi-tenant mode
 *   2. x-api-key header        – single-tenant or key-level throttle
 *   3. Bearer token            – same
 *   4. IP address              – last-resort fallback (req.ip)
 *
 * NOTE: body parsing (express.json()) must run before this middleware.
 */
function resolveKey(req) {
  // 1. Prefer tenantId from body (already parsed by express.json())
  const tenantId = req.body?.tenantId;
  if (tenantId && typeof tenantId === 'string' && tenantId.trim()) {
    return `tenant:${tenantId.trim()}`;
  }

  // 2. Fall back to the API key used to authenticate
  const xKey = req.headers['x-api-key'];
  if (xKey) return `key:${xKey.trim()}`;

  const auth = req.headers['authorization'] ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return `key:${auth.slice(7).trim()}`;
  }

  // 3. Last resort: IP (covers unauthenticated probing, caught by auth middleware anyway)
  return `ip:${req.ip}`;
}

// ─── Redis store ──────────────────────────────────────────────────────────────
// A single IORedis client shared by both limiters.  We use a dedicated client
// (not the one from engine modules) so rate-limiting stays isolated from
// application Redis failures and vice-versa.  lazyConnect: true means the
// connection is attempted on first command, not at import time, so the module
// loads cleanly in environments where Redis may not be up yet (e.g. test runners).

const redisClient = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
  lazyConnect:          true,
  enableOfflineQueue:   false,   // fail fast — don't queue commands if Redis is down
  maxRetriesPerRequest: 1,       // one retry then surface the error
  connectTimeout:       2_000,
});

redisClient.on('error', (err) => {
  // Log but do not crash — see the startup probe below for how we avoid
  // ever handing RedisStore a client that isn't actually connected yet.
  console.warn('[rate-limit] Redis connection error (falling back to in-process counters):', err.message);
});

// ─── startup connectivity probe ────────────────────────────────────────────────
// rate-limit-redis's RedisStore constructor fires off loadIncrementScript()
// immediately and does NOT await it — it's a fire-and-forget promise. With
// lazyConnect + enableOfflineQueue:false, calling redisClient before it has
// actually connected makes that first command reject synchronously, and
// since nothing downstream awaits or catches that promise, it surfaces as an
// unhandled rejection and crashes the whole process (Node >=15 default
// behaviour) instead of falling back gracefully as intended.
//
// To avoid ever letting RedisStore touch an unconnected client, we resolve
// connectivity up front (bounded by connectTimeout) and only build
// Redis-backed stores if that succeeds. If it fails, `makeRedisStore`
// returns undefined and express-rate-limit falls back to its built-in
// in-process MemoryStore — the graceful degradation the comments describe,
// now actually implemented.
let redisAvailable = false;
try {
  await redisClient.connect();
  redisAvailable = true;
} catch (err) {
  console.warn('[rate-limit] Redis unavailable at startup — using in-process counters for this process:', err.message);
}

/**
 * Build a RedisStore for one limiter, namespaced by prefix so rolling and burst
 * windows don't collide in the same Redis keyspace. Returns undefined (which
 * makes express-rate-limit use its default in-memory store) if Redis wasn't
 * reachable at startup.
 *
 * @param {string} prefix  e.g. 'rl:rolling:' or 'rl:burst:'
 */
function makeRedisStore(prefix) {
  if (!redisAvailable) return undefined;
  return new RedisStore({
    // rate-limit-redis v4 uses a sendCommand adapter so it works with any Redis
    // client library.  For ioredis the adapter is a simple .call() wrapper.
    sendCommand: (command, ...args) => redisClient.call(command, ...args),
    prefix,
  });
}

// ─── config ───────────────────────────────────────────────────────────────────

const WINDOW_MS  = envInt('RATE_LIMIT_WINDOW_MS',  60_000);   // 1 minute
const MAX        = envInt('RATE_LIMIT_MAX',         60);       // 60 req / min
const BURST_MS   = envInt('RATE_LIMIT_BURST_MS',   5_000);    // 5 seconds
const BURST_MAX  = envInt('RATE_LIMIT_BURST_MAX',  20);       // 20 req / 5 s

// ─── rolling-window limiter ───────────────────────────────────────────────────

const rollingLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX,
  keyGenerator: resolveKey,
  standardHeaders: true,   // Return RateLimit-* headers (RFC 6585 draft-7)
  legacyHeaders: false,    // Disable X-RateLimit-* legacy headers
  store: makeRedisStore('rl:rolling:'),
  message: (req) => ({
    error: 'Too many requests. Please slow down.',
    retryAfter: Math.ceil(WINDOW_MS / 1000),
    key: resolveKey(req),
  }),
  skip: (req) => {
    // Never rate-limit health checks
    return req.path === '/health';
  },
});

// ─── burst limiter (short spike protection) ───────────────────────────────────

const burstLimiter = rateLimit({
  windowMs: BURST_MS,
  max: BURST_MAX,
  keyGenerator: resolveKey,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeRedisStore('rl:burst:'),
  message: (req) => ({
    error: 'Request burst limit exceeded. Please wait a moment.',
    retryAfter: Math.ceil(BURST_MS / 1000),
    key: resolveKey(req),
  }),
  skip: (req) => req.path === '/health',
});

// ─── combined export ──────────────────────────────────────────────────────────

/**
 * taskRateLimiter
 *
 * Apply both the rolling-window and burst limiters in sequence.
 * Attach to any route that fans out work (POST /task, POST /resume, etc.).
 *
 * Express calls next() only when both limiters pass, so the route handler
 * never sees a throttled request.
 */
export function taskRateLimiter(req, res, next) {
  rollingLimiter(req, res, (err) => {
    if (err) return next(err);
    burstLimiter(req, res, next);
  });
}

/**
 * Expose individual limiters so tests or other routes can import them
 * independently if needed.
 */
export { rollingLimiter, burstLimiter };
