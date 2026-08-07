/**
 * tests/integration/system/redis-streams-queue.system.test.js
 *
 * SYSTEM TEST — requires a live Redis instance. Skipped automatically when
 * Redis is unreachable (see redis-queue.system.test.js for the BullMQ
 * equivalent; this exercises engine/adapters/redis-streams-adapter.js
 * directly rather than a raw client, since the adapter owns the
 * priority-tier fan-out and delayed-job promotion logic under test).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import IORedis from 'ioredis';
import { createRedisStreamsAdapter } from '../../../engine/adapters/redis-streams-adapter.js';

const REDIS_URL   = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_TENANT = `sys-streams-${Date.now()}`;

async function isRedisReachable() {
  const probe = new IORedis(REDIS_URL, { lazyConnect: true, enableOfflineQueue: false });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

describe('System: Redis Streams adapter — live queue round-trip', () => {
  let skip = false;
  let cleanupConn;

  beforeAll(async () => {
    skip = !(await isRedisReachable());
    if (skip) {
      console.warn('[system-test] Redis not reachable — skipping redis-streams adapter tests.');
      return;
    }
    cleanupConn = new IORedis(REDIS_URL);
  });

  afterAll(async () => {
    if (!cleanupConn) return;
    const keys = await cleanupConn.keys(`*${TEST_TENANT}*`);
    if (keys.length) await cleanupConn.del(...keys);
    cleanupConn.disconnect();
  });

  it('job added at CRITICAL priority is picked up ahead of a pre-queued LOW job', async () => {
    if (skip) return;

    const adapter = createRedisStreamsAdapter();
    const seen = [];
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    // Queue LOW first, then CRITICAL — worker should still process CRITICAL first
    // since it polls tiers in fixed priority order each cycle.
    await adapter.addStep('wf-1', { id: 'low-step' }, adapter.Priority.LOW, TEST_TENANT);
    await adapter.addStep('wf-1', { id: 'critical-step' }, adapter.Priority.CRITICAL, TEST_TENANT);

    const worker = adapter.createTaskWorker(TEST_TENANT, async (job) => {
      seen.push(job.data.step.id);
      if (seen.length === 2) resolveDone();
    });

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))
    ]);

    expect(seen[0]).toBe('critical-step');
    expect(seen).toHaveLength(2);
    await worker.close();
  });

  it('delayed addStep is not delivered until its delay elapses', async () => {
    if (skip) return;

    const adapter = createRedisStreamsAdapter();
    const seen = [];
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    const startedAt = Date.now();
    await adapter.addStep(
      'wf-2', { id: 'delayed-step' }, adapter.Priority.NORMAL, TEST_TENANT, { delay: 1500 }
    );

    const worker = adapter.createTaskWorker(TEST_TENANT, async (job) => {
      seen.push({ id: job.data.step.id, at: Date.now() - startedAt });
      resolveDone();
    });

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))
    ]);

    expect(seen[0].at).toBeGreaterThanOrEqual(1400); // small tolerance below 1500ms
    await worker.close();
  });

  it('failed job (all attempts exhausted) emits "failed" instead of hanging', async () => {
    if (skip) return;

    const adapter = createRedisStreamsAdapter();
    let failedEvent;
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    await adapter.addStep(
      'wf-3', { id: 'boom-step' }, adapter.Priority.NORMAL, TEST_TENANT, { attempts: 2, backoff: { type: 'fixed', delay: 50 } }
    );

    const worker = adapter.createTaskWorker(TEST_TENANT, async () => {
      throw new Error('intentional failure');
    });
    worker.on('failed', (job, err) => {
      failedEvent = { attemptsMade: job.attemptsMade, message: err.message };
      resolveDone();
    });

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000))
    ]);

    expect(failedEvent.attemptsMade).toBe(2);
    expect(failedEvent.message).toBe('intentional failure');
    await worker.close();
  });
});
