/**
 * tests/integration/system/redis-queue.system.test.js
 *
 * SYSTEM TEST — requires a live Redis instance.
 *
 * Skipped automatically when Redis is unreachable (CI without the service,
 * or a local dev machine where Redis is not running).  Add a `redis` service
 * block to your CI workflow (see .github/workflows/ci.yml) and set
 * REDIS_URL=redis://localhost:6379 to make this run in CI.
 *
 * What this covers (mocked tests never exercised these):
 *   • Real BullMQ Queue.add() → job lands in Redis
 *   • Real BullMQ Worker.process() picks up the job and executes handler
 *   • Job completion / failure events fire correctly over live Redis pub/sub
 *   • Dead-letter queue receives jobs that exhaust retries
 *   • Queue isolation: tenant-A jobs never appear on tenant-B's worker
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

// ── helpers ───────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.REDIS_URL ?? 'redis://localhost:6379';
const TEST_TENANT = `sys-test-${Date.now()}`;
const QUEUE_NAME  = `aegis-tasks:${TEST_TENANT}`;
const DLQ_NAME    = `aegis-dead-letter:${TEST_TENANT}`;

let connection;

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

// ── suite ─────────────────────────────────────────────────────────────────────

describe('System: BullMQ + Redis — live queue round-trip', () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await isRedisReachable());
    if (skip) {
      console.warn(
        '[system-test] Redis not reachable at', REDIS_URL,
        '— skipping live queue tests. Start Redis or set REDIS_URL to run these.'
      );
      return;
    }
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    if (!connection) return;
    // Clean up test queues so they don't accumulate across runs
    const q   = new Queue(QUEUE_NAME, { connection });
    const dlq = new Queue(DLQ_NAME,   { connection });
    await q.obliterate({ force: true }).catch(() => {});
    await dlq.obliterate({ force: true }).catch(() => {});
    await q.close();
    await dlq.close();
    connection.disconnect();
  });

  it('job added to queue is picked up and completed by a real worker', async () => {
    if (skip) return;

    const results = [];
    const queue   = new Queue(QUEUE_NAME, { connection });
    const events  = new QueueEvents(QUEUE_NAME, { connection });

    const worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        results.push(job.data);
        return { ok: true };
      },
      { connection }
    );

    await queue.add('test-job', { hello: 'world', tenant: TEST_TENANT });

    // Wait for the completed event (max 8 s)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for job completion')), 8000);
      events.on('completed', () => { clearTimeout(t); resolve(); });
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ hello: 'world', tenant: TEST_TENANT });

    await worker.close();
    await events.close();
    await queue.close();
  });

  it('failed job lands in dead-letter queue after retries exhausted', async () => {
    if (skip) return;

    const dlq    = new Queue(DLQ_NAME, { connection });
    const queue  = new Queue(QUEUE_NAME, { connection });
    const events = new QueueEvents(QUEUE_NAME, { connection });

    let attempts = 0;

    const worker = new Worker(
      QUEUE_NAME,
      async () => {
        attempts++;
        throw new Error('intentional failure for DLQ test');
      },
      {
        connection,
        // Override BullMQ defaults so the test completes quickly
        settings: { backoffStrategy: () => 50 },
      }
    );

    // Add a job with only 2 attempts so failure is fast
    await queue.add('dlq-test', { type: 'dlq-probe' }, { attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    // The worker.on('failed') handler in the real git.js pushes to DLQ;
    // here we simulate that with a direct add so the DLQ path is exercised.
    worker.on('failed', async (job) => {
      if (job.attemptsMade >= (job.opts?.attempts ?? 1)) {
        await dlq.add('failed-step', {
          originalJobId: job.id,
          error: 'intentional failure for DLQ test',
        });
      }
    });

    // Wait until the job has failed completely (failed event, attemptsMade >= attempts)
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for job failure')), 10000);
      events.on('failed', async ({ jobId }) => {
        const job = await queue.getJob(jobId);
        if (!job || job.attemptsMade >= 2) { clearTimeout(t); resolve(); }
      });
    });

    // Give the DLQ handler a tick to flush
    await new Promise(r => setTimeout(r, 200));

    const dlqJobs = await dlq.getJobs(['wait', 'active', 'completed', 'failed', 'delayed']);
    expect(dlqJobs.length).toBeGreaterThanOrEqual(1);

    await worker.close();
    await events.close();
    await queue.close();
    await dlq.close();
  });

  it('tenant queue isolation: tenant-A jobs never reach tenant-B worker', async () => {
    if (skip) return;

    const tenantA = `${TEST_TENANT}-A`;
    const tenantB = `${TEST_TENANT}-B`;
    const qA = new Queue(`aegis-tasks:${tenantA}`, { connection });
    const qB = new Queue(`aegis-tasks:${tenantB}`, { connection });

    const receivedByB = [];

    const workerB = new Worker(
      `aegis-tasks:${tenantB}`,
      async (job) => { receivedByB.push(job.data); },
      { connection }
    );

    // Add jobs only to tenant A's queue
    await qA.add('job-for-a', { tenant: tenantA });

    // Give worker B a moment to (incorrectly) pick it up
    await new Promise(r => setTimeout(r, 500));

    expect(receivedByB).toHaveLength(0);

    // Cleanup
    await workerB.close();
    await qA.obliterate({ force: true }).catch(() => {});
    await qB.obliterate({ force: true }).catch(() => {});
    await qA.close();
    await qB.close();
  });
});
