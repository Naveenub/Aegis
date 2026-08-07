import {
  SQSClient,
  CreateQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { assertTenantId, DEFAULT_TENANT } from '../tenant.js';
import { Priority, TIERS, tierForPriority } from './priority-tiers.js';

// engine/adapters/sqs-adapter.js
//
// SQS implementation of the queue adapter interface
// (see engine/queue-adapter.js for the interface contract).
//
// Design notes (deviations from BullMQ, agreed before implementation):
//   - No native priority → 4 physical queues per tenant (one per tier);
//     workers poll critical → low each cycle.
//   - No native per-job attempts/backoff → the worker receives one
//     message, runs the processor up to opts.attempts times with backoff
//     between attempts, and only deletes the message once it either
//     succeeds or exhausts attempts. VISIBILITY_TIMEOUT_S must exceed the
//     worst-case total retry time or the message can be redelivered
//     mid-retry — sized generously below; tune per deployment.
//   - No "list all messages by state" API → getJobs() does a
//     non-destructive peek (VisibilityTimeout: 0) and is therefore
//     approximate (may double-count messages another consumer also has
//     in flight, or momentarily miss in-flight ones). Good enough for the
//     /dlq audit endpoint; not a substitute for a real queue depth metric.

const VISIBILITY_TIMEOUT_S = 600;
const MAX_DELAY_S = 900; // SQS hard limit

export function createSQSAdapter() {
  const client = new SQSClient({ region: process.env.AWS_REGION || 'us-east-1' });
  const _queueUrls = new Map(); // queue name -> URL

  const taskQueueName = (tenantId, tier) => `aegis-tasks-${tier}-${tenantId}`;
  const dlqQueueName  = (tenantId)       => `aegis-dead-letter-${tenantId}`;

  async function ensureQueue(name) {
    if (_queueUrls.has(name)) return _queueUrls.get(name);
    const { QueueUrl } = await client.send(new CreateQueueCommand({ QueueName: name }));
    _queueUrls.set(name, QueueUrl);
    return QueueUrl;
  }

  function parseMessage(message) {
    const payload = JSON.parse(message.Body);
    return {
      id: payload.id,
      data: payload.data,
      opts: payload.opts ?? {},
      timestamp: payload.timestamp,
      failedReason: null,
      attemptsMade: 0,
      getState: async () => 'waiting',
      _receiptHandle: message.ReceiptHandle
    };
  }

  function backoffMs(backoff, attemptNum) {
    if (!backoff) return 0;
    if (backoff.type === 'fixed') return backoff.delay;
    return backoff.delay * Math.pow(2, attemptNum - 1);
  }

  function makeAdd(queueUrlPromiseFactory, defaultOpts) {
    return async (name, data, opts = {}) => {
      const jobOpts = { ...defaultOpts, ...opts };
      const queueUrl = await queueUrlPromiseFactory(jobOpts);
      const id = randomUUID();
      const delaySeconds = jobOpts.delay
        ? Math.min(Math.floor(jobOpts.delay / 1000), MAX_DELAY_S)
        : 0;
      await client.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ id, data, opts: jobOpts, timestamp: Date.now() }),
        DelaySeconds: delaySeconds
      }));
      return { id, data };
    };
  }

  function getTaskQueue(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    return {
      add: makeAdd(
        (jobOpts) => ensureQueue(taskQueueName(tenantId, tierForPriority(jobOpts.priority))),
        { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
      )
    };
  }

  function getDeadLetterQueue(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    const name = dlqQueueName(tenantId);
    return {
      add: makeAdd(() => ensureQueue(name), {}),
      // Non-destructive peek — see file header note on approximation.
      getJobs: async (states, start = 0, end = 99) => {
        const queueUrl = await ensureQueue(name);
        const wanted = end - start + 1;
        const seen = new Map();
        let emptyStreak = 0;
        while (seen.size < wanted && emptyStreak < 3) {
          const { Messages } = await client.send(new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            VisibilityTimeout: 0,
            WaitTimeSeconds: 1
          }));
          if (!Messages || Messages.length === 0) { emptyStreak++; continue; }
          emptyStreak = 0;
          for (const m of Messages) {
            const job = parseMessage(m);
            seen.set(job.id, job);
          }
        }
        return [...seen.values()].slice(start, end + 1);
      }
    };
  }

  function getQueueEvents(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    // SQS has no native completion pub/sub; production code only reads
    // this for a backward-compat export (engine/queue.js) and never
    // subscribes to it. Stub keeps the interface shape intact.
    return new EventEmitter();
  }

  function makeWorker(queueUrlsFactory, processor) {
    const emitter = new EventEmitter();
    let closed = false;

    (async () => {
      const queueUrls = await queueUrlsFactory();
      while (!closed) {
        let received = null;
        for (const queueUrl of queueUrls) {
          const { Messages } = await client.send(new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            VisibilityTimeout: VISIBILITY_TIMEOUT_S,
            WaitTimeSeconds: 2
          })).catch(() => ({}));
          if (Messages && Messages.length) {
            received = { queueUrl, message: Messages[0] };
            break; // critical → low priority order preserved by queueUrls
          }
        }
        if (!received) continue;

        const job = parseMessage(received.message);
        const attempts = job.opts.attempts ?? 3;
        let lastErr = null;

        for (let attemptNum = 1; attemptNum <= attempts; attemptNum++) {
          job.attemptsMade = attemptNum;
          try {
            await processor(job);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attemptNum < attempts) {
              await new Promise(r => setTimeout(r, backoffMs(job.opts.backoff, attemptNum)));
            }
          }
        }

        await client.send(new DeleteMessageCommand({
          QueueUrl: received.queueUrl,
          ReceiptHandle: job._receiptHandle
        })).catch(() => {});
        if (lastErr) emitter.emit('failed', job, lastErr);
      }
    })();

    emitter.close = async () => { closed = true; };
    return emitter;
  }

  function createTaskWorker(tenantId, processor) {
    assertTenantId(tenantId);
    return makeWorker(
      () => Promise.all(TIERS.map(tier => ensureQueue(taskQueueName(tenantId, tier)))),
      processor
    );
  }

  function createDeadLetterWorker(tenantId, processor) {
    assertTenantId(tenantId);
    return makeWorker(() => ensureQueue(dlqQueueName(tenantId)).then(url => [url]), processor);
  }

  async function addStep(workflowId, step, priority = Priority.NORMAL, tenantId = DEFAULT_TENANT, jobOpts = {}) {
    return getTaskQueue(tenantId).add('step', { workflowId, step, tenantId }, { priority, ...jobOpts });
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
