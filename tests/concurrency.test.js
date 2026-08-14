/**
 * tests/concurrency.test.js
 *
 * Unit tests for engine/concurrency.js
 *
 * Covers:
 *   getLimit()     — priority-tier mapping and unknown-priority fallback
 *   acquireSlot()  — happy path, limit enforcement, slot release, timeout, stale pruning
 *   slotStatus()   — active count, holder list, limit field
 *   clearSlots()   — removes all holders for a workflow
 *
 * Redis is fully mocked — no live connection required.
 * Timer-dependent paths (timeout, poll interval) use vi.useFakeTimers().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Redis mock ────────────────────────────────────────────────────────────────
//
// concurrency.js uses:
//   zremrangebyscore(key, '-inf', cutoff)  — prune expired slots
//   zcard(key)                             — count active slots
//   zadd(key, score, member)               — claim a slot
//   pexpire(key, ms)                       — key-level TTL backstop
//   zrem(key, member)                      — release a slot
//   zrange(key, 0, -1)                     — list holders
//   del(key)                               — clear all slots
//
// The mock keeps a single per-key Map<member → score> so all z-commands
// stay consistent without a real sorted-set implementation.

vi.mock('ioredis', () => {
  // Per-key sorted-set store: key → Map<member, score>
  const zsets = new Map();

  function getZset(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }

  const client = {
    on: () => {},
    // Prune members whose score ≤ cutoff
    zremrangebyscore: vi.fn(async (key, _min, max) => {
      const z = getZset(key);
      let removed = 0;
      for (const [m, score] of z) {
        if (score <= Number(max)) { z.delete(m); removed++; }
      }
      return removed;
    }),

    zcard: vi.fn(async (key) => getZset(key).size),

    zadd: vi.fn(async (key, score, member) => {
      const z = getZset(key);
      const isNew = !z.has(member);
      z.set(member, score);
      return isNew ? 1 : 0;
    }),

    pexpire: vi.fn(async () => 1),

    zrem: vi.fn(async (key, member) => {
      const z = getZset(key);
      const had = z.has(member);
      z.delete(member);
      return had ? 1 : 0;
    }),

    zrange: vi.fn(async (key) => [...getZset(key).keys()]),

    del: vi.fn(async (key) => { zsets.delete(key); return 1; }),

    // Expose internals for test assertions
    _zsets: zsets,
    _reset() { zsets.clear(); },
    _setSlots(key, entries) {
      // entries: [[member, score], ...]
      const z = new Map(entries);
      zsets.set(key, z);
    },
  };

  return { default: vi.fn(() => client), __client: client };
});

// ─── module under test (imported after mock) ──────────────────────────────────

import { acquireSlot, slotStatus, clearSlots, getLimit } from '../engine/concurrency.js';

// ─── helper to get the mock client ───────────────────────────────────────────

async function getClient() {
  const ioredis = await import('ioredis');
  return ioredis.__client;
}

// ─── reset between tests ──────────────────────────────────────────────────────

beforeEach(async () => {
  const client = await getClient();
  client._reset();
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. getLimit() — priority-tier mapping
// ═══════════════════════════════════════════════════════════════════════════════

describe('getLimit()', () => {
  it('returns 8 for CRITICAL priority (0)', () => {
    expect(getLimit(0)).toBe(8);
  });

  it('returns 5 for HIGH priority (1)', () => {
    expect(getLimit(1)).toBe(5);
  });

  it('returns 3 for NORMAL priority (5)', () => {
    expect(getLimit(5)).toBe(3);
  });

  it('returns 1 for LOW priority (10)', () => {
    expect(getLimit(10)).toBe(1);
  });

  it('returns the default limit (3) for an unknown priority value', () => {
    expect(getLimit(99)).toBe(3);
    expect(getLimit(7)).toBe(3);
  });

  it('returns 3 when priority is omitted (falls through to DEFAULT_LIMIT)', () => {
    // getLimit(undefined) → LIMITS[undefined] = undefined → DEFAULT_LIMIT
    expect(getLimit(undefined)).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. slotStatus() — inspect active slot usage
// ═══════════════════════════════════════════════════════════════════════════════

describe('slotStatus()', () => {
  it('returns 0 active slots and empty holders list for a fresh workflow', async () => {
    const status = await slotStatus('wf-empty', 5);
    expect(status.active).toBe(0);
    expect(status.holders).toEqual([]);
    expect(status.limit).toBe(3); // NORMAL priority
  });

  it('reports the correct limit for each priority tier', async () => {
    const cases = [[0, 8], [1, 5], [5, 3], [10, 1]];
    for (const [priority, expected] of cases) {
      const s = await slotStatus('wf-limit', priority);
      expect(s.limit).toBe(expected);
    }
  });

  it('lists all active slot holders', async () => {
    const client = await getClient();
    const now = Date.now();
    // Seed two non-expired slots
    client._setSlots('aegis:sem:wf-holders', [
      ['job-A', now],
      ['job-B', now],
    ]);
    const status = await slotStatus('wf-holders', 5);
    expect(status.active).toBe(2);
    expect(status.holders.sort()).toEqual(['job-A', 'job-B']);
  });

  it('excludes expired slots from the count (prunes before reading)', async () => {
    const client = await getClient();
    const staleScore = Date.now() - 999_999; // Way past lease TTL
    client._setSlots('aegis:sem:wf-stale', [
      ['job-stale', staleScore],
      ['job-fresh', Date.now()],
    ]);
    const status = await slotStatus('wf-stale', 5);
    // The stale entry is pruned; only the fresh one counts
    expect(status.active).toBe(1);
    expect(status.holders).toEqual(['job-fresh']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. clearSlots()
// ═══════════════════════════════════════════════════════════════════════════════

describe('clearSlots()', () => {
  it('removes all slot holders for a workflow', async () => {
    const client = await getClient();
    client._setSlots('aegis:sem:wf-clear', [['job-1', Date.now()], ['job-2', Date.now()]]);

    await clearSlots('wf-clear');

    const status = await slotStatus('wf-clear', 5);
    expect(status.active).toBe(0);
    expect(status.holders).toEqual([]);
  });

  it('is safe to call on a workflow with no slots', async () => {
    await expect(clearSlots('wf-nonexistent')).resolves.not.toThrow();
  });

  it('only clears slots for the targeted workflow, not others', async () => {
    const client = await getClient();
    client._setSlots('aegis:sem:wf-A', [['job-1', Date.now()]]);
    client._setSlots('aegis:sem:wf-B', [['job-2', Date.now()]]);

    await clearSlots('wf-A');

    const statusA = await slotStatus('wf-A', 5);
    const statusB = await slotStatus('wf-B', 5);
    expect(statusA.active).toBe(0);
    expect(statusB.active).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. acquireSlot() — happy path
// ═══════════════════════════════════════════════════════════════════════════════

describe('acquireSlot() — happy path', () => {
  it('returns a release handle with workflowId and jobId', async () => {
    const handle = await acquireSlot('wf-1', 'job-1', 5);
    expect(handle.workflowId).toBe('wf-1');
    expect(handle.jobId).toBe('job-1');
    expect(typeof handle.release).toBe('function');
  });

  it('slot appears in slotStatus after acquire', async () => {
    await acquireSlot('wf-2', 'job-A', 5);
    const status = await slotStatus('wf-2', 5);
    expect(status.active).toBe(1);
    expect(status.holders).toContain('job-A');
  });

  it('releasing a slot removes it from slotStatus', async () => {
    const handle = await acquireSlot('wf-3', 'job-B', 5);
    await handle.release();
    const status = await slotStatus('wf-3', 5);
    expect(status.active).toBe(0);
    expect(status.holders).not.toContain('job-B');
  });

  it('release is idempotent — calling it twice does not throw', async () => {
    const handle = await acquireSlot('wf-4', 'job-C', 5);
    await handle.release();
    await expect(handle.release()).resolves.not.toThrow();
  });

  it('multiple jobs can hold slots up to the priority limit', async () => {
    // CRITICAL priority allows 8 slots
    const handles = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        acquireSlot('wf-critical', `job-${i}`, 0)
      )
    );
    const status = await slotStatus('wf-critical', 0);
    expect(status.active).toBe(8);
    // Clean up
    for (const h of handles) await h.release();
  });

  it('LOW priority (limit=1): second slot becomes available after first is released', async () => {
    const h1 = await acquireSlot('wf-low', 'job-first', 10);
    await h1.release();

    // Now the slot is free — should acquire immediately
    const h2 = await acquireSlot('wf-low', 'job-second', 10);
    expect(h2.jobId).toBe('job-second');
    await h2.release();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. acquireSlot() — limit enforcement & timeout
// ═══════════════════════════════════════════════════════════════════════════════

describe('acquireSlot() — limit enforcement & timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when no slot is available within ACQUIRE_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    // Fill all LOW-priority slots (limit = 1)
    const client = await getClient();
    client._setSlots('aegis:sem:wf-full', [['job-holder', Date.now()]]);

    // We need to advance fake time so the timeout fires.
    // acquireSlot polls every POLL_INTERVAL_MS (500ms) and gives up at
    // ACQUIRE_TIMEOUT_MS (10 min by default). We advance past that.
    const acquirePromise = acquireSlot('wf-full', 'job-waiter', 10);

    // Advance time well past the default 10 min timeout
    vi.advanceTimersByTime(11 * 60 * 1000);

    await expect(acquirePromise).rejects.toThrow(/Concurrency slot acquire timeout/);
  }, 15_000);

  it('timeout error includes workflowId and limit in the message', async () => {
    vi.useFakeTimers();

    const client = await getClient();
    // Fill the single LOW slot
    client._setSlots('aegis:sem:wf-timeout-msg', [['holder', Date.now()]]);

    const p = acquireSlot('wf-timeout-msg', 'waiter', 10);
    vi.advanceTimersByTime(11 * 60 * 1000);

    await expect(p).rejects.toThrow('wf-timeout-msg');
  }, 15_000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. acquireSlot() — expired slot pruning
// ═══════════════════════════════════════════════════════════════════════════════

describe('acquireSlot() — expired slot pruning', () => {
  it('acquires successfully when the only existing slot is expired', async () => {
    const client = await getClient();
    // Slot score far in the past (older than LEASE_MS = 2 min)
    const expiredScore = Date.now() - 5 * 60 * 1000;
    client._setSlots('aegis:sem:wf-expired', [['dead-job', expiredScore]]);

    // LOW priority limit is 1 — but dead-job should be pruned, freeing the slot
    const handle = await acquireSlot('wf-expired', 'live-job', 10);
    expect(handle.jobId).toBe('live-job');
    await handle.release();
  });

  it('counts only live slots when checking against the limit', async () => {
    const client = await getClient();
    const expiredScore = Date.now() - 5 * 60 * 1000;
    // 3 expired + 1 fresh for NORMAL priority (limit = 3)
    client._setSlots('aegis:sem:wf-mixed', [
      ['exp-1', expiredScore],
      ['exp-2', expiredScore],
      ['exp-3', expiredScore],
      ['live-1', Date.now()],
    ]);

    // After pruning 3 expired slots, active count = 1 < limit 3 → should acquire
    const handle = await acquireSlot('wf-mixed', 'new-job', 5);
    expect(handle.jobId).toBe('new-job');
    await handle.release();
  });
});
