import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from '../tenant.js';

// ─── Priority tiers (lower number = higher priority in BullMQ) ────────────────
export const Priority = {
  CRITICAL: 0,
  HIGH:     1,
  NORMAL:   5,
  LOW:      10
};

/**
 * BullMQ + Redis implementation of the queue adapter interface
 * (see engine/queue-adapter.js for the interface contract).
 */
export function createBullMQAdapter() {
  // maxRetriesPerRequest: null is required by BullMQ for any connection
  // used to construct a Worker (blocking Redis commands). Sharing it here
  // means Queue/QueueEvents instances use the same setting, which is safe.
  const connection = new IORedis(process.env.REDIS_URL || undefined, {
    maxRetriesPerRequest: null
  });

  const _queues   = new Map();
  const _dlQueues = new Map();
  const _qEvents  = new Map();

  const tenantQueueName = (tenantId) => `aegis-tasks:${tenantId}`;
  const tenantDLQName   = (tenantId) => `aegis-dead-letter:${tenantId}`;

  function getTaskQueue(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    if (!_queues.has(tenantId)) {
      _queues.set(tenantId, new Queue(tenantQueueName(tenantId), {
        connection,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false
        }
      }));
    }
    return _queues.get(tenantId);
  }

  function getDeadLetterQueue(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    if (!_dlQueues.has(tenantId)) {
      _dlQueues.set(tenantId, new Queue(tenantDLQName(tenantId), { connection }));
    }
    return _dlQueues.get(tenantId);
  }

  function getQueueEvents(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    if (!_qEvents.has(tenantId)) {
      _qEvents.set(tenantId, new QueueEvents(tenantQueueName(tenantId), { connection }));
    }
    return _qEvents.get(tenantId);
  }

  async function addStep(workflowId, step, priority = Priority.NORMAL, tenantId = DEFAULT_TENANT, jobOpts = {}) {
    return getTaskQueue(tenantId).add(
      'step',
      { workflowId, step, tenantId },
      { priority, ...jobOpts }
    );
  }

  // Worker creation is NOT cached here — callers (engine/git.js,
  // workers/dlq-worker.js) already cache one worker per tenant for the
  // process lifetime and call this only on first use.
  function createTaskWorker(tenantId, processor) {
    assertTenantId(tenantId);
    return new Worker(tenantQueueName(tenantId), processor, { connection });
  }

  function createDeadLetterWorker(tenantId, processor) {
    assertTenantId(tenantId);
    return new Worker(tenantDLQName(tenantId), processor, { connection });
  }

  return {
    Priority,
    getTaskQueue,
    getDeadLetterQueue,
    getQueueEvents,
    addStep,
    createTaskWorker,
    createDeadLetterWorker
  };
}
