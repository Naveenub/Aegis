import { createBullMQAdapter } from './adapters/bullmq-adapter.js';

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
 * Only "bullmq" is implemented today; add a new backend by writing an
 * engine/adapters/<name>-adapter.js that returns this same shape and
 * wiring it in below.
 */
let _adapter;

export function getQueueAdapter() {
  if (_adapter) return _adapter;

  const backend = process.env.QUEUE_BACKEND || 'bullmq';
  if (backend !== 'bullmq') {
    throw new Error(`Unsupported QUEUE_BACKEND: "${backend}". Only "bullmq" is implemented.`);
  }

  _adapter = createBullMQAdapter();
  return _adapter;
}
