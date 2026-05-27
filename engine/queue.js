import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { assertTenantId, DEFAULT_TENANT } from './tenant.js';

const connection = new IORedis();

// ─── Priority tiers (lower number = higher priority in BullMQ) ────────────────
export const Priority = {
  CRITICAL: 0,
  HIGH:     1,
  NORMAL:   5,
  LOW:      10
};

// Each tenant gets its own BullMQ queue so jobs never interleave.
// Queues are created lazily and cached for the process lifetime.
const _queues     = new Map();
const _dlQueues   = new Map();
const _qEvents    = new Map();

function tenantQueueName(tenantId) {
  return `aegis-tasks:${tenantId}`;
}

function tenantDLQName(tenantId) {
  return `aegis-dead-letter:${tenantId}`;
}

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

export function getDeadLetterQueue(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  if (!_dlQueues.has(tenantId)) {
    _dlQueues.set(tenantId, new Queue(tenantDLQName(tenantId), { connection }));
  }
  return _dlQueues.get(tenantId);
}

export function getQueueEvents(tenantId = DEFAULT_TENANT) {
  assertTenantId(tenantId);
  if (!_qEvents.has(tenantId)) {
    _qEvents.set(tenantId, new QueueEvents(tenantQueueName(tenantId), { connection }));
  }
  return _qEvents.get(tenantId);
}

/**
 * Schedule a workflow step with explicit priority.
 */
export async function addStep(workflowId, step, priority = Priority.NORMAL, tenantId = DEFAULT_TENANT) {
  return getTaskQueue(tenantId).add(
    'step',
    { workflowId, step, tenantId },
    { priority }
  );
}

// Legacy single-tenant exports kept for backwards compat (maps to DEFAULT_TENANT)
export const taskQueue     = getTaskQueue(DEFAULT_TENANT);
export const deadLetterQueue = getDeadLetterQueue(DEFAULT_TENANT);
export const queueEvents   = getQueueEvents(DEFAULT_TENANT);