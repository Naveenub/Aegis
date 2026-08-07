import { createBullMQAdapter } from './adapters/bullmq-adapter.js';
import { createSQSAdapter } from './adapters/sqs-adapter.js';
import { createRedisStreamsAdapter } from './adapters/redis-streams-adapter.js';

/**
 * Queue adapter interface. Any backend must implement:
 *
 *   Priority                                    - priority tier constants
 *   addStep(workflowId, step, priority, tenantId, jobOpts) -> Promise
 *   getTaskQueue(tenantId)                      -> queue handle { add }
 *   getDeadLetterQueue(tenantId)                -> queue handle { add, getJobs }
 *   getQueueEvents(tenantId)                    -> event emitter { on }
 *   createTaskWorker(tenantId, processor)       -> worker handle { on }
 *   createDeadLetterWorker(tenantId, processor) -> worker handle { on }
 *
 * Backend selection is via the QUEUE_BACKEND env var (default: "bullmq").
 * Supported: "bullmq" (Redis-backed, native priority), "sqs", "redis-streams".
 * The latter two have no native per-message priority, so they fan work
 * across 4 physical queues/streams per tenant (see adapters/priority-tiers.js).
 * Add another backend by writing engine/adapters/<name>-adapter.js that
 * returns this same shape and wiring it in below.
 */
let _adapter;

export function getQueueAdapter() {
  if (_adapter) return _adapter;

  const backend = process.env.QUEUE_BACKEND || 'bullmq';
  switch (backend) {
    case 'bullmq':
      _adapter = createBullMQAdapter();
      break;
    case 'sqs':
      _adapter = createSQSAdapter();
      break;
    case 'redis-streams':
      _adapter = createRedisStreamsAdapter();
      break;
    default:
      throw new Error(
        `Unsupported QUEUE_BACKEND: "${backend}". Must be one of: bullmq, sqs, redis-streams.`
      );
  }
  return _adapter;
}
