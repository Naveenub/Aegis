import IORedis from 'ioredis';
import { EventEmitter } from 'node:events';
import { assertTenantId, DEFAULT_TENANT } from '../tenant.js';
import { Priority, TIERS, tierForPriority } from './priority-tiers.js';

// engine/adapters/redis-streams-adapter.js
//
// Redis Streams implementation of the queue adapter interface
// (see engine/queue-adapter.js for the interface contract).
//
// Design notes (deviations from BullMQ, agreed before implementation):
//   - No native priority → 4 physical streams per tenant (one per tier),
//     each with its own consumer group; workers poll critical → low.
//   - No native delay → a per-tenant ZSET ("aegis-delayed:{tenantId}")
//     holds jobs not yet due; a poller promotes them to the tier stream
//     once their score (executeAt ms) has passed. ZREM is used as the
//     claim so multiple worker processes never double-promote.
//   - No native per-job attempts/backoff → the worker reads one entry,
//     runs the processor up to opts.attempts times with backoff between
//     attempts, and only XACKs/XDELs once it either succeeds or exhausts
//     attempts. Visibility (redelivery) is therefore not relied on for
//     retries — the entry stays pending for the whole retry loop.

const GROUP = 'aegis-workers';

export function createRedisStreamsAdapter() {
  const connection = new IORedis(process.env.REDIS_URL || undefined, {
    maxRetriesPerRequest: null
  });

  const _knownTenants = new Set();
  const _groupsReady   = new Set();
  let _pollerStarted   = false;

  const taskStream  = (tenantId, tier) => `aegis-tasks:${tier}:${tenantId}`;
  const dlqStream   = (tenantId)       => `aegis-dead-letter:${tenantId}`;
  const delayedKey  = (tenantId)       => `aegis-delayed:${tenantId}`;

  async function ensureGroup(stream) {
    if (_groupsReady.has(stream)) return;
    try {
      await connection.xgroup('CREATE', stream, GROUP, '$', 'MKSTREAM');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
    _groupsReady.add(stream);
  }

  function parseEntry(id, fields) {
    const payload = JSON.parse(fields[1]); // fields === ['payload', json]
    return {
      id,
      data: payload.data,
      opts: payload.opts ?? {},
      timestamp: payload.timestamp,
      failedReason: null,
      attemptsMade: 0,
      getState: async () => 'waiting'
    };
  }

  function backoffMs(backoff, attemptNum) {
    if (!backoff) return 0;
    if (backoff.type === 'fixed') return backoff.delay;
    return backoff.delay * Math.pow(2, attemptNum - 1);
  }

  // ── delayed-job poller (one per process, shared across tenants seen) ───────
  function startDelayedPoller() {
    if (_pollerStarted) return;
    _pollerStarted = true;
    setInterval(async () => {
      const now = Date.now();
      for (const tenantId of _knownTenants) {
        const key = delayedKey(tenantId);
        const due = await connection.zrangebyscore(key, 0, now).catch(() => []);
        for (const raw of due) {
          const removed = await connection.zrem(key, raw);
          if (!removed) continue; // another process already claimed this entry
          const entry = JSON.parse(raw);
          const stream = taskStream(tenantId, entry.tier);
          await ensureGroup(stream);
          await connection.xadd(stream, '*', 'payload', JSON.stringify({
            data: entry.data, opts: entry.opts, timestamp: Date.now()
          }));
        }
      }
    }, 1000).unref();
  }

  function getTaskQueue(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    _knownTenants.add(tenantId);
    startDelayedPoller();
    return {
      add: async (name, data, opts = {}) => {
        const jobOpts = {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          ...opts
        };
        const tier = tierForPriority(jobOpts.priority);
        if (jobOpts.delay > 0) {
          await connection.zadd(
            delayedKey(tenantId),
            Date.now() + jobOpts.delay,
            JSON.stringify({ tier, data, opts: jobOpts })
          );
          return { id: 'delayed', data };
        }
        const stream = taskStream(tenantId, tier);
        await ensureGroup(stream);
        const id = await connection.xadd(
          stream, '*', 'payload', JSON.stringify({ data, opts: jobOpts, timestamp: Date.now() })
        );
        return { id, data };
      }
    };
  }

  function getDeadLetterQueue(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    const stream = dlqStream(tenantId);
    return {
      add: async (name, data, opts = {}) => {
        await ensureGroup(stream);
        const id = await connection.xadd(
          stream, '*', 'payload', JSON.stringify({ data, opts, timestamp: Date.now() })
        );
        return { id, data };
      },
      // Approximate: XRANGE returns oldest-first regardless of `states`
      // (Streams has no per-entry state). `start`/`end` are applied as a
      // post-fetch slice — callers in this codebase always pass start=0.
      getJobs: async (states, start = 0, end = 99) => {
        const count = end - start + 1;
        const entries = await connection.xrange(stream, '-', '+', 'COUNT', Math.max(count, 1));
        return entries.slice(start).map(([id, fields]) => parseEntry(id, fields));
      }
    };
  }

  function getQueueEvents(tenantId = DEFAULT_TENANT) {
    assertTenantId(tenantId);
    // Streams has no native completion pub/sub; production code only reads
    // this for a backward-compat export (engine/queue.js) and never
    // subscribes to it. Stub keeps the interface shape intact.
    return new EventEmitter();
  }

  function makeWorker(streams, processor) {
    const emitter  = new EventEmitter();
    const consumer = `c-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    let closed = false;

    (async () => {
      for (const s of streams) await ensureGroup(s);
      while (!closed) {
        let claimed = null;
        for (const stream of streams) {
          const res = await connection.xreadgroup(
            'GROUP', GROUP, consumer, 'COUNT', 1, 'BLOCK', 200, 'STREAMS', stream, '>'
          ).catch(() => null);
          if (res && res.length && res[0][1].length) {
            const [entryId, fields] = res[0][1][0];
            claimed = { stream, entryId, fields };
            break; // critical → low priority order preserved by `streams`
          }
        }
        if (!claimed) continue;

        const job = parseEntry(claimed.entryId, claimed.fields);
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

        await connection.xack(claimed.stream, GROUP, claimed.entryId);
        await connection.xdel(claimed.stream, claimed.entryId);
        if (lastErr) emitter.emit('failed', job, lastErr);
      }
    })();

    emitter.close = async () => { closed = true; };
    return emitter;
  }

  function createTaskWorker(tenantId, processor) {
    assertTenantId(tenantId);
    return makeWorker(TIERS.map(tier => taskStream(tenantId, tier)), processor);
  }

  function createDeadLetterWorker(tenantId, processor) {
    assertTenantId(tenantId);
    return makeWorker([dlqStream(tenantId)], processor);
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
