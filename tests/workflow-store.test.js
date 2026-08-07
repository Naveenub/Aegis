/**
 * tests/workflow-store.test.js
 *
 * Unit tests for engine/workflow-store.js
 *
 * Covers:
 *   createWorkflow()      — persists meta + steps, correct initial status
 *   getWorkflow()         — assembles meta + steps, returns null when missing
 *   updateStep()          — flips step.status, sets updatedAt
 *   resetStepForRetry()   — zeroes attempt/lastError/lastPatch, sets status=pending
 *   getWorkflowStatus()   — fast status read without full hydration
 *   isWorkflowTimedOut()  — wall-clock timeout logic
 *   pauseWorkflow()       — only pauses running workflows
 *   resumeWorkflow()      — only resumes paused workflows
 *   cancelWorkflow()      — blocks on completed/cancelled, clears concurrency slots
 *   failWorkflow()        — marks failed + clears slots
 *   flagForReview()       — writes record + adds to sorted index
 *   getReviewQueue()      — status filter, ordering, limit
 *   resolveReview()       — updates status/resolvedAt/note, returns record
 *
 * Redis and the concurrency module are fully mocked — no live deps required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── mock concurrency (clearSlots is called by cancel/fail) ───────────────────

vi.mock('../engine/concurrency.js', () => ({
  clearSlots: vi.fn(async () => undefined),
}));

// ─── Redis mock ────────────────────────────────────────────────────────────────
//
// workflow-store uses:
//   get / set                  — workflow meta (JSON strings)
//   hset / hget / hgetall      — step hashes
//   pipeline → { hset, set, exec }
//   zadd / zrevrange           — review index (sorted set)
//
// All data is held in three plain Maps so every test starts from a clean slate.

vi.mock('ioredis', () => {
  const kv      = new Map(); // key → string  (meta, review records)
  const hashes  = new Map(); // key → Map<field, string>
  const zsets   = new Map(); // key → Map<member, score>

  function getHash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }

  function getZset(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }

  const client = {
    // ── string ops ──────────────────────────────────────────────────────────
    get:  vi.fn(async (k)    => kv.get(k) ?? null),
    set:  vi.fn(async (k, v) => { kv.set(k, v); return 'OK'; }),

    // ── hash ops ────────────────────────────────────────────────────────────
    hget: vi.fn(async (k, f) => getHash(k).get(f) ?? null),
    hset: vi.fn(async (k, f, v) => {
      getHash(k).set(f, v);
      return 1;
    }),
    hgetall: vi.fn(async (k) => {
      const h = hashes.get(k);
      if (!h || h.size === 0) return {};
      return Object.fromEntries(h);
    }),

    // ── sorted set ops (review queue) ────────────────────────────────────────
    zadd: vi.fn(async (k, score, member) => {
      getZset(k).set(member, score);
      return 1;
    }),
    // zrevrange: return members ordered highest score → lowest, sliced [start..stop]
    zrevrange: vi.fn(async (k, start, stop) => {
      const z = getZset(k);
      const sorted = [...z.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([m]) => m);
      const end = stop === -1 ? sorted.length : stop + 1;
      return sorted.slice(start, end);
    }),

    // ── pub/sub ──────────────────────────────────────────────────────────────
    // publishWorkflowEvent() fires on cancel/fail/complete; best-effort, so the
    // mock just needs to resolve (and .catch() safely if a test wants to force
    // an error path).
    publish: vi.fn(async () => 1),

    // ── pipeline — used by createWorkflow and flagForReview ─────────────────
    pipeline: vi.fn(() => {
      const ops = [];
      const pipe = {
        hset: vi.fn((...args) => { ops.push(['hset', args]); return pipe; }),
        set:  vi.fn((...args) => { ops.push(['set',  args]); return pipe; }),
        zadd: vi.fn((...args) => { ops.push(['zadd', args]); return pipe; }),
        // getReviewQueue uses pipeline.get(key) to batch-fetch review records
        get:  vi.fn((...args) => { ops.push(['get',  args]); return pipe; }),
        exec: vi.fn(async () => {
          const results = [];
          for (const [cmd, args] of ops) {
            if (cmd === 'hset') { await client.hset(...args); results.push([null, 1]); }
            if (cmd === 'set')  { await client.set(...args);  results.push([null, 'OK']); }
            if (cmd === 'zadd') { await client.zadd(...args); results.push([null, 1]); }
            if (cmd === 'get')  { const v = await client.get(...args); results.push([null, v]); }
          }
          return results;
        }),
      };
      return pipe;
    }),

    // ── expose internals ─────────────────────────────────────────────────────
    _kv:     kv,
    _hashes: hashes,
    _zsets:  zsets,
    _reset() { kv.clear(); hashes.clear(); zsets.clear(); },
  };

  return { default: vi.fn(() => client), __client: client };
});

// ─── imports (after mocks) ────────────────────────────────────────────────────

import {
  createWorkflow,
  getWorkflow,
  updateStep,
  resetStepForRetry,
  getWorkflowStatus,
  isWorkflowTimedOut,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  failWorkflow,
  flagForReview,
  getReviewQueue,
  resolveReview,
} from '../engine/workflow-store.js';

import { clearSlots } from '../engine/concurrency.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

async function resetDb() {
  const ioredis = await import('ioredis');
  ioredis.__client._reset();
  vi.clearAllMocks();
}

function makeStep(overrides = {}) {
  return { id: 'step-1', agent: 'feature-builder', description: 'do it',
           depends_on: [], ...overrides };
}

beforeEach(resetDb);

// ═══════════════════════════════════════════════════════════════════════════════
// 1. createWorkflow() + getWorkflow()
// ═══════════════════════════════════════════════════════════════════════════════

describe('createWorkflow() + getWorkflow()', () => {
  it('persists a workflow and retrieves it with the correct meta fields', async () => {
    await createWorkflow('wf-create-1', [makeStep()], { priority: 5 });
    const wf = await getWorkflow('wf-create-1');

    expect(wf).not.toBeNull();
    expect(wf.id).toBe('wf-create-1');
    expect(wf.status).toBe('running');
    expect(wf.priority).toBe(5);
    expect(typeof wf.startedAt).toBe('number');
    expect(typeof wf.createdAt).toBe('number');
  });

  it('all steps are stored with status=pending', async () => {
    const steps = [makeStep({ id: 's1' }), makeStep({ id: 's2' })];
    await createWorkflow('wf-create-2', steps, {});
    const wf = await getWorkflow('wf-create-2');

    expect(wf.steps).toHaveLength(2);
    for (const s of wf.steps) {
      expect(s.status).toBe('pending');
    }
  });

  it('persists tenantId and timeoutMs when provided', async () => {
    await createWorkflow('wf-create-3', [makeStep()], {
      tenantId: 'acme', timeoutMs: 30_000
    });
    const wf = await getWorkflow('wf-create-3');
    expect(wf.tenantId).toBe('acme');
    expect(wf.timeoutMs).toBe(30_000);
  });

  it('defaults tenantId to null and timeoutMs to null when omitted', async () => {
    await createWorkflow('wf-create-4', [makeStep()], {});
    const wf = await getWorkflow('wf-create-4');
    expect(wf.tenantId).toBeNull();
    expect(wf.timeoutMs).toBeNull();
  });

  it('returns null for a workflow that does not exist', async () => {
    expect(await getWorkflow('wf-does-not-exist')).toBeNull();
  });

  it('handles multiple steps including those with depends_on', async () => {
    await createWorkflow('wf-dag', [
      makeStep({ id: 'a', depends_on: [] }),
      makeStep({ id: 'b', depends_on: ['a'] }),
    ], {});
    const wf = await getWorkflow('wf-dag');
    const ids = wf.steps.map(s => s.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. updateStep()
// ═══════════════════════════════════════════════════════════════════════════════

describe('updateStep()', () => {
  it('flips a step status from pending to running', async () => {
    await createWorkflow('wf-upd-1', [makeStep({ id: 'step-1' })], {});
    await updateStep('wf-upd-1', 'step-1', 'running');
    const wf = await getWorkflow('wf-upd-1');
    const s = wf.steps.find(x => x.id === 'step-1');
    expect(s.status).toBe('running');
  });

  it('sets updatedAt on the step', async () => {
    const before = Date.now();
    await createWorkflow('wf-upd-2', [makeStep({ id: 'step-1' })], {});
    await updateStep('wf-upd-2', 'step-1', 'completed');
    const wf = await getWorkflow('wf-upd-2');
    const s = wf.steps.find(x => x.id === 'step-1');
    expect(s.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('is a no-op when the stepId does not exist', async () => {
    await createWorkflow('wf-upd-3', [makeStep({ id: 'real' })], {});
    // Should not throw
    await expect(updateStep('wf-upd-3', 'ghost', 'completed')).resolves.not.toThrow();
  });

  it('transitions through the full lifecycle: pending → running → completed', async () => {
    await createWorkflow('wf-upd-4', [makeStep({ id: 'step-1' })], {});
    for (const status of ['running', 'completed']) {
      await updateStep('wf-upd-4', 'step-1', status);
    }
    const wf = await getWorkflow('wf-upd-4');
    expect(wf.steps[0].status).toBe('completed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. resetStepForRetry()
// ═══════════════════════════════════════════════════════════════════════════════

describe('resetStepForRetry()', () => {
  it('resets status to pending and zeroes attempt', async () => {
    await createWorkflow('wf-reset-1', [
      makeStep({ id: 'step-1', status: 'needs-review', attempt: 3 })
    ], {});
    const reset = await resetStepForRetry('wf-reset-1', 'step-1');
    expect(reset.status).toBe('pending');
    expect(reset.attempt).toBe(0);
  });

  it('clears lastError and lastPatch', async () => {
    await createWorkflow('wf-reset-2', [
      makeStep({ id: 'step-1', lastError: 'boom', lastPatch: '{...}' })
    ], {});
    const reset = await resetStepForRetry('wf-reset-2', 'step-1');
    expect(reset.lastError).toBeNull();
    expect(reset.lastPatch).toBeNull();
  });

  it('sets updatedAt to a recent timestamp', async () => {
    const before = Date.now();
    await createWorkflow('wf-reset-3', [makeStep({ id: 'step-1' })], {});
    const reset = await resetStepForRetry('wf-reset-3', 'step-1');
    expect(reset.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('persists the reset step — getWorkflow reflects the new state', async () => {
    await createWorkflow('wf-reset-4', [
      makeStep({ id: 'step-1', attempt: 5, lastError: 'failed' })
    ], {});
    await resetStepForRetry('wf-reset-4', 'step-1');
    const wf = await getWorkflow('wf-reset-4');
    const s = wf.steps.find(x => x.id === 'step-1');
    expect(s.status).toBe('pending');
    expect(s.attempt).toBe(0);
  });

  it('returns null for a step that does not exist', async () => {
    await createWorkflow('wf-reset-5', [makeStep({ id: 'step-1' })], {});
    const result = await resetStepForRetry('wf-reset-5', 'ghost');
    expect(result).toBeNull();
  });

  it('preserves other step fields (agent, description, depends_on)', async () => {
    await createWorkflow('wf-reset-6', [
      makeStep({ id: 'step-1', agent: 'debugger', description: 'Fix it',
                 depends_on: ['step-0'] })
    ], {});
    const reset = await resetStepForRetry('wf-reset-6', 'step-1');
    expect(reset.agent).toBe('debugger');
    expect(reset.description).toBe('Fix it');
    expect(reset.depends_on).toEqual(['step-0']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. getWorkflowStatus()
// ═══════════════════════════════════════════════════════════════════════════════

describe('getWorkflowStatus()', () => {
  it('returns "running" immediately after createWorkflow', async () => {
    await createWorkflow('wf-status-1', [makeStep()], {});
    expect(await getWorkflowStatus('wf-status-1')).toBe('running');
  });

  it('returns null for a non-existent workflow', async () => {
    expect(await getWorkflowStatus('wf-ghost')).toBeNull();
  });

  it('returns "paused" after pauseWorkflow', async () => {
    await createWorkflow('wf-status-2', [makeStep()], {});
    await pauseWorkflow('wf-status-2');
    expect(await getWorkflowStatus('wf-status-2')).toBe('paused');
  });

  it('returns "cancelled" after cancelWorkflow', async () => {
    await createWorkflow('wf-status-3', [makeStep()], {});
    await cancelWorkflow('wf-status-3');
    expect(await getWorkflowStatus('wf-status-3')).toBe('cancelled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. isWorkflowTimedOut()
// ═══════════════════════════════════════════════════════════════════════════════

describe('isWorkflowTimedOut()', () => {
  it('returns false when timeoutMs is not set', async () => {
    await createWorkflow('wf-to-1', [makeStep()], {});
    expect(await isWorkflowTimedOut('wf-to-1')).toBe(false);
  });

  it('returns false when timeoutMs is null', async () => {
    await createWorkflow('wf-to-2', [makeStep()], { timeoutMs: null });
    expect(await isWorkflowTimedOut('wf-to-2')).toBe(false);
  });

  it('returns false when elapsed time is less than timeoutMs', async () => {
    await createWorkflow('wf-to-3', [makeStep()], { timeoutMs: 999_999 });
    expect(await isWorkflowTimedOut('wf-to-3')).toBe(false);
  });

  it('returns true when the workflow has exceeded its timeout', async () => {
    // Create a workflow and then backdate its startedAt
    await createWorkflow('wf-to-4', [makeStep()], { timeoutMs: 1000 });

    // Directly manipulate the meta to simulate a workflow that started 2 s ago
    const ioredis = await import('ioredis');
    const client  = ioredis.__client;
    const metaRaw = await client.get('aegis:workflow:meta:wf-to-4');
    const meta    = JSON.parse(metaRaw);
    meta.startedAt = Date.now() - 2000; // 2 s ago, timeout is 1 s
    await client.set('aegis:workflow:meta:wf-to-4', JSON.stringify(meta));

    expect(await isWorkflowTimedOut('wf-to-4')).toBe(true);
  });

  it('returns false for a non-existent workflow', async () => {
    expect(await isWorkflowTimedOut('wf-ghost')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. pauseWorkflow() + resumeWorkflow()
// ═══════════════════════════════════════════════════════════════════════════════

describe('pauseWorkflow()', () => {
  it('returns true and sets status=paused for a running workflow', async () => {
    await createWorkflow('wf-pause-1', [makeStep()], {});
    const ok = await pauseWorkflow('wf-pause-1');
    expect(ok).toBe(true);
    expect(await getWorkflowStatus('wf-pause-1')).toBe('paused');
  });

  it('sets pausedAt timestamp', async () => {
    const before = Date.now();
    await createWorkflow('wf-pause-2', [makeStep()], {});
    await pauseWorkflow('wf-pause-2');
    const wf = await getWorkflow('wf-pause-2');
    expect(wf.pausedAt).toBeGreaterThanOrEqual(before);
  });

  it('returns false for a non-existent workflow', async () => {
    expect(await pauseWorkflow('wf-ghost')).toBe(false);
  });

  it('returns false when workflow is already paused', async () => {
    await createWorkflow('wf-pause-3', [makeStep()], {});
    await pauseWorkflow('wf-pause-3');
    expect(await pauseWorkflow('wf-pause-3')).toBe(false);
  });

  it('returns false when workflow is cancelled', async () => {
    await createWorkflow('wf-pause-4', [makeStep()], {});
    await cancelWorkflow('wf-pause-4');
    expect(await pauseWorkflow('wf-pause-4')).toBe(false);
  });
});

describe('resumeWorkflow()', () => {
  it('returns true and sets status=running for a paused workflow', async () => {
    await createWorkflow('wf-resume-1', [makeStep()], {});
    await pauseWorkflow('wf-resume-1');
    const ok = await resumeWorkflow('wf-resume-1');
    expect(ok).toBe(true);
    expect(await getWorkflowStatus('wf-resume-1')).toBe('running');
  });

  it('sets resumedAt and clears pausedAt', async () => {
    const before = Date.now();
    await createWorkflow('wf-resume-2', [makeStep()], {});
    await pauseWorkflow('wf-resume-2');
    await resumeWorkflow('wf-resume-2');
    const wf = await getWorkflow('wf-resume-2');
    expect(wf.resumedAt).toBeGreaterThanOrEqual(before);
    expect(wf.pausedAt).toBeUndefined();
  });

  it('returns false for a running (not paused) workflow', async () => {
    await createWorkflow('wf-resume-3', [makeStep()], {});
    expect(await resumeWorkflow('wf-resume-3')).toBe(false);
  });

  it('returns false for a non-existent workflow', async () => {
    expect(await resumeWorkflow('wf-ghost')).toBe(false);
  });

  it('full pause → resume → pause cycle works', async () => {
    await createWorkflow('wf-cycle', [makeStep()], {});
    await pauseWorkflow('wf-cycle');
    await resumeWorkflow('wf-cycle');
    const ok = await pauseWorkflow('wf-cycle');
    expect(ok).toBe(true);
    expect(await getWorkflowStatus('wf-cycle')).toBe('paused');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. cancelWorkflow()
// ═══════════════════════════════════════════════════════════════════════════════

describe('cancelWorkflow()', () => {
  it('returns true and sets status=cancelled for a running workflow', async () => {
    await createWorkflow('wf-cancel-1', [makeStep()], {});
    const ok = await cancelWorkflow('wf-cancel-1');
    expect(ok).toBe(true);
    expect(await getWorkflowStatus('wf-cancel-1')).toBe('cancelled');
  });

  it('stores the cancellation reason', async () => {
    await createWorkflow('wf-cancel-2', [makeStep()], {});
    await cancelWorkflow('wf-cancel-2', 'user request');
    const wf = await getWorkflow('wf-cancel-2');
    expect(wf.cancelReason).toBe('user request');
  });

  it('calls clearSlots to release concurrency slots', async () => {
    await createWorkflow('wf-cancel-3', [makeStep()], {});
    await cancelWorkflow('wf-cancel-3');
    expect(clearSlots).toHaveBeenCalledWith('wf-cancel-3');
  });

  it('returns false for a non-existent workflow', async () => {
    expect(await cancelWorkflow('wf-ghost')).toBe(false);
  });

  it('returns false if workflow is already cancelled', async () => {
    await createWorkflow('wf-cancel-4', [makeStep()], {});
    await cancelWorkflow('wf-cancel-4');
    expect(await cancelWorkflow('wf-cancel-4')).toBe(false);
  });

  it('returns false if workflow is already completed', async () => {
    // Manually set status to completed
    await createWorkflow('wf-cancel-5', [makeStep()], {});
    const ioredis = await import('ioredis');
    const client  = ioredis.__client;
    const raw = await client.get('aegis:workflow:meta:wf-cancel-5');
    const meta = JSON.parse(raw);
    meta.status = 'completed';
    await client.set('aegis:workflow:meta:wf-cancel-5', JSON.stringify(meta));

    expect(await cancelWorkflow('wf-cancel-5')).toBe(false);
  });

  it('can cancel a paused workflow', async () => {
    await createWorkflow('wf-cancel-6', [makeStep()], {});
    await pauseWorkflow('wf-cancel-6');
    expect(await cancelWorkflow('wf-cancel-6')).toBe(true);
    expect(await getWorkflowStatus('wf-cancel-6')).toBe('cancelled');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. failWorkflow()
// ═══════════════════════════════════════════════════════════════════════════════

describe('failWorkflow()', () => {
  it('sets status=failed and stores the reason', async () => {
    await createWorkflow('wf-fail-1', [makeStep()], {});
    await failWorkflow('wf-fail-1', 'unrecoverable error');
    const wf = await getWorkflow('wf-fail-1');
    expect(wf.status).toBe('failed');
    expect(wf.reason).toBe('unrecoverable error');
  });

  it('calls clearSlots', async () => {
    await createWorkflow('wf-fail-2', [makeStep()], {});
    await failWorkflow('wf-fail-2', 'crash');
    expect(clearSlots).toHaveBeenCalledWith('wf-fail-2');
  });

  it('is a no-op for a non-existent workflow (does not throw)', async () => {
    await expect(failWorkflow('wf-ghost', 'err')).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. flagForReview()
// ═══════════════════════════════════════════════════════════════════════════════

describe('flagForReview()', () => {
  it('returns a record with status=pending and correct ids', async () => {
    const rec = await flagForReview('wf-flag-1', 'step-1', { error: 'boom' });
    expect(rec.workflowId).toBe('wf-flag-1');
    expect(rec.stepId).toBe('step-1');
    expect(rec.status).toBe('pending');
    expect(rec.error).toBe('boom');
  });

  it('sets flaggedAt to a recent timestamp when not provided', async () => {
    const before = Date.now();
    const rec = await flagForReview('wf-flag-2', 'step-1', {});
    expect(rec.flaggedAt).toBeGreaterThanOrEqual(before);
  });

  it('respects an explicit flaggedAt in details', async () => {
    const ts = 1_700_000_000_000;
    const rec = await flagForReview('wf-flag-3', 'step-1', { flaggedAt: ts });
    expect(rec.flaggedAt).toBe(ts);
  });

  it('merges arbitrary detail fields into the record', async () => {
    const rec = await flagForReview('wf-flag-4', 'step-1', {
      agent: 'debugger', description: 'Something went wrong',
    });
    expect(rec.agent).toBe('debugger');
    expect(rec.description).toBe('Something went wrong');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. getReviewQueue()
// ═══════════════════════════════════════════════════════════════════════════════

describe('getReviewQueue()', () => {
  it('returns an empty array when no items have been flagged', async () => {
    const items = await getReviewQueue({ status: 'pending' });
    expect(items).toEqual([]);
  });

  it('returns flagged items with status=pending by default', async () => {
    await flagForReview('wf-q-1', 'step-1', { error: 'e1' });
    await flagForReview('wf-q-1', 'step-2', { error: 'e2' });
    const items = await getReviewQueue({ status: 'pending' });
    expect(items).toHaveLength(2);
    expect(items.every(i => i.status === 'pending')).toBe(true);
  });

  it('filters by status — resolved items are excluded from pending query', async () => {
    await flagForReview('wf-q-2', 'step-1', {});
    await flagForReview('wf-q-2', 'step-2', {});
    await resolveReview('wf-q-2', 'step-1', 'resolved');

    const pending = await getReviewQueue({ status: 'pending' });
    expect(pending.every(i => i.status === 'pending')).toBe(true);

    const resolved = await getReviewQueue({ status: 'resolved' });
    expect(resolved.every(i => i.status === 'resolved')).toBe(true);
  });

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await flagForReview(`wf-q-3-${i}`, 'step-1', {});
    }
    const items = await getReviewQueue({ limit: 3, status: 'pending' });
    expect(items.length).toBeLessThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. resolveReview()
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveReview()', () => {
  it('updates the review record status', async () => {
    await flagForReview('wf-res-1', 'step-1', {});
    const rec = await resolveReview('wf-res-1', 'step-1', 'resolved');
    expect(rec.status).toBe('resolved');
  });

  it('sets resolvedAt to a recent timestamp', async () => {
    const before = Date.now();
    await flagForReview('wf-res-2', 'step-1', {});
    const rec = await resolveReview('wf-res-2', 'step-1', 'skipped');
    expect(rec.resolvedAt).toBeGreaterThanOrEqual(before);
  });

  it('stores the optional note field', async () => {
    await flagForReview('wf-res-3', 'step-1', {});
    const rec = await resolveReview('wf-res-3', 'step-1', 'resolved', 'Fixed manually');
    expect(rec.note).toBe('Fixed manually');
  });

  it('persists changes — subsequent getReviewQueue reflects the new status', async () => {
    await flagForReview('wf-res-4', 'step-1', {});
    await resolveReview('wf-res-4', 'step-1', 'skipped');

    const pending  = await getReviewQueue({ status: 'pending' });
    const skipped  = await getReviewQueue({ status: 'skipped' });
    expect(pending.find(i => i.stepId === 'step-1')).toBeUndefined();
    expect(skipped.find(i => i.stepId === 'step-1')).toBeDefined();
  });

  it('returns false for a non-existent review record', async () => {
    const result = await resolveReview('wf-ghost', 'step-ghost', 'resolved');
    expect(result).toBe(false);
  });

  it('supports all three resolution types: resolved, skipped, retrying', async () => {
    for (const resolution of ['resolved', 'skipped', 'retrying']) {
      await flagForReview(`wf-res-${resolution}`, 'step-1', {});
      const rec = await resolveReview(`wf-res-${resolution}`, 'step-1', resolution);
      expect(rec.status).toBe(resolution);
    }
  });
});
