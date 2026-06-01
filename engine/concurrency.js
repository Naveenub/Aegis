/**
 * concurrency.js
 *
 * Per-workflow concurrency limiter using a Redis-backed counting semaphore.
 *
 * Problem:
 *   When 50 CRITICAL steps become runnable simultaneously, all 50 are enqueued
 *   and workers pick them all up at once — hammering the AI API, the Git layer,
 *   and the test runner with no throttle.
 *
 * Solution:
 *   Before a worker touches any shared resource it must acquire a semaphore
 *   slot for its workflow. The slot is held for the duration of the step and
 *   released (always, even on failure) in a finally block.
 *
 *   Limits are tuned per priority tier so CRITICAL workflows get more
 *   concurrent slots than LOW-priority ones.
 *
 * Redis keys:
 *   aegis:sem:{workflowId}          ZSET  — set of active slot holders
 *                                           member  = jobId
 *                                           score   = acquiredAt (ms epoch)
 *
 * Lease TTL:
 *   Each slot has a wall-clock lease. If a worker crashes mid-step the slot
 *   would stay held forever without the TTL. The TTL is checked on every
 *   acquire attempt via pruneExpiredSlots(), so no external cron is needed.
 *
 * Defaults (overridable via env):
 *   AEGIS_CONCURRENCY_CRITICAL = 8
 *   AEGIS_CONCURRENCY_HIGH     = 5
 *   AEGIS_CONCURRENCY_NORMAL   = 3
 *   AEGIS_CONCURRENCY_LOW      = 1
 *   AEGIS_CONCURRENCY_LEASE_MS = 120000  (2 min — max expected step wall-time)
 */

import IORedis from 'ioredis';

const redis = new IORedis();

// ─── Limits per priority tier ─────────────────────────────────────────────────
// Priority values match BullMQ convention: lower number = higher priority.
// 0 = CRITICAL, 1 = HIGH, 5 = NORMAL, 10 = LOW

const LIMITS = {
  0:  parseInt(process.env.AEGIS_CONCURRENCY_CRITICAL ?? '8'),
  1:  parseInt(process.env.AEGIS_CONCURRENCY_HIGH     ?? '5'),
  5:  parseInt(process.env.AEGIS_CONCURRENCY_NORMAL   ?? '3'),
  10: parseInt(process.env.AEGIS_CONCURRENCY_LOW      ?? '1'),
};

// Fallback for unknown priority values
const DEFAULT_LIMIT = parseInt(process.env.AEGIS_CONCURRENCY_DEFAULT ?? '3');

// How long (ms) a slot may be held before it is considered stale and pruned
const LEASE_MS = parseInt(process.env.AEGIS_CONCURRENCY_LEASE_MS ?? String(2 * 60 * 1000));

// How long (ms) to wait between acquire retries when all slots are full
const POLL_INTERVAL_MS = parseInt(process.env.AEGIS_CONCURRENCY_POLL_MS ?? '500');

// Max total time to wait for a slot before giving up and throwing
const ACQUIRE_TIMEOUT_MS = parseInt(process.env.AEGIS_CONCURRENCY_ACQUIRE_TIMEOUT_MS ?? String(10 * 60 * 1000));

// ─── Internal helpers ─────────────────────────────────────────────────────────

function semKey(workflowId) {
  return `aegis:sem:${workflowId}`;
}

function limitForPriority(priority) {
  return LIMITS[priority] ?? DEFAULT_LIMIT;
}

/**
 * Remove any slot holders whose lease has expired.
 * Called before every acquire attempt — no external cron needed.
 */
async function pruneExpiredSlots(workflowId) {
  const cutoff = Date.now() - LEASE_MS;
  await redis.zremrangebyscore(semKey(workflowId), '-inf', cutoff);
}

/**
 * Return the number of currently active (non-expired) slots.
 */
export async function activeSlotCount(workflowId) {
  await pruneExpiredSlots(workflowId);
  return redis.zcard(semKey(workflowId));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire a concurrency slot for a workflow step.
 *
 * Blocks (polls) until a slot is available or ACQUIRE_TIMEOUT_MS is exceeded.
 * On success returns a release handle — callers MUST call release() in finally.
 *
 * @param {string} workflowId
 * @param {string} jobId       — unique identifier for this slot holder
 * @param {number} priority    — BullMQ priority value (0=CRITICAL … 10=LOW)
 * @returns {{ release: () => Promise<void>, workflowId: string, jobId: string }}
 * @throws if no slot is available within ACQUIRE_TIMEOUT_MS
 */
export async function acquireSlot(workflowId, jobId, priority = 5) {
  const limit   = limitForPriority(priority);
  const started = Date.now();

  while (true) {
    await pruneExpiredSlots(workflowId);

    const key    = semKey(workflowId);
    const active = await redis.zcard(key);

    if (active < limit) {
      // Claim the slot atomically: score = acquiredAt for TTL-based pruning
      await redis.zadd(key, Date.now(), jobId);
      // Set a key-level TTL as a hard backstop (slightly longer than lease)
      await redis.pexpire(key, LEASE_MS * 2);

      return {
        workflowId,
        jobId,

        /**
         * Release this slot. Safe to call multiple times (idempotent).
         */
        async release() {
          try {
            await redis.zrem(semKey(workflowId), jobId);
          } catch {
            // Best-effort: lease TTL will clean up if this fails
          }
        }
      };
    }

    // All slots full — check timeout before sleeping
    if (Date.now() - started > ACQUIRE_TIMEOUT_MS) {
      throw new Error(
        `Concurrency slot acquire timeout for workflow ${workflowId} ` +
        `(limit=${limit}, priority=${priority}, waited=${ACQUIRE_TIMEOUT_MS}ms)`
      );
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Inspect current slot usage for a workflow (useful for metrics / debugging).
 *
 * @param {string} workflowId
 * @returns {{ active: number, limit: number, holders: string[] }}
 */
export async function slotStatus(workflowId, priority = 5) {
  await pruneExpiredSlots(workflowId);
  const holders = await redis.zrange(semKey(workflowId), 0, -1);
  return {
    active:   holders.length,
    limit:    limitForPriority(priority),
    holders,
  };
}

/**
 * Force-clear all slots for a workflow.
 * Called when a workflow is cancelled or completed so stale slots don't
 * block future runs with the same workflowId.
 */
export async function clearSlots(workflowId) {
  await redis.del(semKey(workflowId));
}

/**
 * Return the configured limit for a priority tier (for logging/metrics).
 */
export function getLimit(priority) {
  return limitForPriority(priority);
}
