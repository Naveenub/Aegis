/**
 * engine/status.js
 *
 * Public service status for GET /status. Meant to be polled by an external
 * monitor or hosted status page (it must live outside this service, or it goes
 * down with it). `outage` → HTTP 503 so plain uptime probes work unmodified.
 *
 * Components: `api` (always up if this runs) and `redis` (queue, locks, rate
 * limits, vector search — a Redis outage stops all work, so it is an outage).
 */
import IORedis from 'ioredis';

const CHECK_TIMEOUT_MS = 2000;

let _redis = null;
function redis() {
  _redis ??= new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: CHECK_TIMEOUT_MS,
  });
  _redis.on('error', () => {}); // surfaced through the check result, not an unhandled event
  return _redis;
}

async function pingRedis() {
  const r = redis();
  if (r.status === 'wait' || r.status === 'end') await r.connect();
  await r.ping();
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CHECK_TIMEOUT_MS).unref()),
    ]);
    return { status: 'operational', latencyMs: Date.now() - t0 };
  } catch {
    return { status: 'outage', latencyMs: Date.now() - t0 };
  }
}

/**
 * @param {Record<string, () => Promise<void>>} [checks] override for tests
 * @returns {Promise<{ httpStatus: number, body: object }>}
 */
export async function getStatus(checks = { redis: pingRedis }) {
  const components = { api: { status: 'operational' } };
  for (const [name, fn] of Object.entries(checks)) components[name] = await timed(fn);
  const down = Object.values(components).some((c) => c.status === 'outage');
  const status = down ? 'outage' : 'operational';
  return { httpStatus: down ? 503 : 200, body: { status, components, ts: Date.now() } };
}
