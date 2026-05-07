import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

const connection = new IORedis();

// ─── Priority tiers (lower number = higher priority in BullMQ) ────────────────
export const Priority = {
  CRITICAL: 0,
  HIGH:     1,
  NORMAL:   5,
  LOW:      10
};

export const taskQueue = new Queue('aegis-tasks', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000 // 2s → 4s → 8s
    },
    removeOnComplete: true,
    removeOnFail: false // keep failed jobs for DLQ inspection
  }
});

/**
 * Schedule a workflow step with explicit priority.
 * @param {string} workflowId
 * @param {object} step
 * @param {number} [priority]  - use Priority.* constants; defaults to NORMAL
 */
export async function addStep(workflowId, step, priority = Priority.NORMAL) {
  return taskQueue.add(
    'step',
    { workflowId, step },
    { priority }
  );
}

export const queueEvents = new QueueEvents('aegis-tasks', { connection });

export const deadLetterQueue = new Queue('aegis-dead-letter', {
  connection
});
