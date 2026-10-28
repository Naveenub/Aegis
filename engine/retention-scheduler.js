/**
 * engine/retention-scheduler.js — in-process safety net for retention purging
 *
 * The primary enforcement path is the daily cron (`npm run retention:sweep`,
 * k8s CronJob 12 / Render cron aegis-retention-sweep). If that cron is never
 * deployed, nothing would be purged. This scheduler runs the same idempotent
 * sweep from the API server so retention is enforced either way.
 *
 * Several replicas (or the cron itself) may fire together, so each run takes a
 * Redis lock (SET NX EX); losers skip. Disable with AEGIS_RETENTION_INPROCESS=off
 * if you run only the external cron.
 */
import IORedis from 'ioredis';
import { runRetentionSweep } from './retention.js';

const LOCK_KEY = 'aegis:retention:sweep-lock';
const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {{stop: () => void} | null} */
export function startRetentionScheduler({ intervalMs = Number(process.env.AEGIS_RETENTION_INTERVAL_MS) || DAY_MS } = {}) {
  if (String(process.env.AEGIS_RETENTION_INPROCESS || 'on').toLowerCase() === 'off') {
    console.info('[retention] in-process scheduler disabled (AEGIS_RETENTION_INPROCESS=off) — make sure the retention cron is deployed');
    return null;
  }
  const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on('error', () => {});

  async function tick() {
    try {
      if (redis.status === 'wait') await redis.connect();
      // Lock lasts just under one interval so a run per interval wins exactly once.
      const ttlSec = Math.max(60, Math.floor(intervalMs / 1000) - 60);
      const got = await redis.set(LOCK_KEY, String(process.pid), 'EX', ttlSec, 'NX');
      if (got !== 'OK') return;
      const r = await runRetentionSweep();
      console.info(`[retention] in-process sweep done: tenants=${Object.keys(r.tenants).length} errors=${r.errors.length}`);
      for (const e of r.errors) console.error('[retention] sweep error', e.scope, e.error);
    } catch (err) {
      console.error('[retention] in-process sweep failed:', err.message);
    }
  }

  // First run shortly after boot (so a fresh deploy catches up), then every interval.
  const first = setTimeout(tick, 60_000);
  const timer = setInterval(tick, intervalMs);
  first.unref?.(); timer.unref?.();
  console.info(`[retention] in-process sweep scheduled every ${Math.round(intervalMs / 3600000)}h (safety net; external cron still recommended)`);
  return { stop() { clearTimeout(first); clearInterval(timer); redis.disconnect(); } };
}
