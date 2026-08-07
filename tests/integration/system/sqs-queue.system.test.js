/**
 * tests/integration/system/sqs-queue.system.test.js
 *
 * SYSTEM TEST — requires reachable SQS (real AWS with credentials, or a
 * LocalStack endpoint via AWS_ENDPOINT_URL). Skipped automatically when
 * neither is configured/reachable, same pattern as the Redis system tests.
 *
 * Exercises engine/adapters/sqs-adapter.js directly: priority-tier
 * fan-out, delayed delivery via DelaySeconds, and attempts/backoff before
 * the "failed" event fires.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SQSClient, CreateQueueCommand, DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { createSQSAdapter } from '../../../engine/adapters/sqs-adapter.js';

const TEST_TENANT = `sys-sqs-${Date.now()}`;

async function isSQSReachable() {
  const client = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  try {
    const name = `aegis-sqs-probe-${Date.now()}`;
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: name }));
    await client.send(new DeleteQueueCommand({ QueueUrl }));
    return true;
  } catch {
    return false;
  }
}

describe('System: SQS adapter — live queue round-trip', () => {
  let skip = false;

  beforeAll(async () => {
    skip = !(await isSQSReachable());
    if (skip) {
      console.warn(
        '[system-test] SQS not reachable — skipping. Set AWS credentials or ' +
        'AWS_ENDPOINT_URL (LocalStack) to run these.'
      );
    }
  });

  it('job added at CRITICAL priority is picked up ahead of a pre-queued LOW job', async () => {
    if (skip) return;

    const adapter = createSQSAdapter();
    const seen = [];
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    await adapter.addStep('wf-1', { id: 'low-step' }, adapter.Priority.LOW, TEST_TENANT);
    await adapter.addStep('wf-1', { id: 'critical-step' }, adapter.Priority.CRITICAL, TEST_TENANT);

    const worker = adapter.createTaskWorker(TEST_TENANT, async (job) => {
      seen.push(job.data.step.id);
      if (seen.length === 2) resolveDone();
    });

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000))
    ]);

    expect(seen[0]).toBe('critical-step');
    expect(seen).toHaveLength(2);
    await worker.close();
  }, 20000);

  it('delayed addStep is not delivered until its delay elapses', async () => {
    if (skip) return;

    const adapter = createSQSAdapter();
    const seen = [];
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    const startedAt = Date.now();
    await adapter.addStep(
      'wf-2', { id: 'delayed-step' }, adapter.Priority.NORMAL, TEST_TENANT, { delay: 3000 }
    );

    const worker = adapter.createTaskWorker(TEST_TENANT, async (job) => {
      seen.push({ id: job.data.step.id, at: Date.now() - startedAt });
      resolveDone();
    });

    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000))
    ]);

    expect(seen[0].at).toBeGreaterThanOrEqual(2800); // small tolerance below 3000ms
    await worker.close();
  }, 20000);

  it('failed job (all attempts exhausted) emits "failed" instead of hanging', async () => {
    if (skip) return;

    const adapter = createSQSAdapter();
    let failedEvent;
    let resolveDone;
    const done = new Promise(r => { resolveDone = r; });

    await adapter.addStep(
      'wf-3', { id: 'boom-step' }, adapter.Priority.NORMAL, TEST_TENANT,
      { attempts: 2, backoff: { type: 'fixed', delay: 50 } }
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
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000))
    ]);

    expect(failedEvent.attemptsMade).toBe(2);
    expect(failedEvent.message).toBe('intentional failure');
    await worker.close();
  }, 20000);
});
