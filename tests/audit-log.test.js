/**
 * tests/audit-log.test.js
 *
 * Unit tests for engine/audit-log.js
 *
 * Covers:
 *   recordAuditEvent()  — appends event, links prevHash to the prior tip,
 *                          rejects missing required fields
 *   queryAuditEvents()  — returns events oldest-first, filters by action/
 *                          resourceType, respects the time range
 *   verifyChain()       — accepts an untampered chain, detects a mutated
 *                          field, detects a forged signature
 *   exportAuditEvents() — JSON envelope carries chainValid; CSV has a header
 *                          row and one row per event
 *
 * Redis is an in-memory mock (kv + hash + zset Maps), matching the pattern
 * used in tests/workflow-store.test.js. The tenant-serialising lock is
 * mocked to a no-op so tests don't depend on redlock/timing.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../engine/lock.js', () => ({
  acquireLock: vi.fn(async () => ({ id: 'lock-stub' })),
  releaseLock: vi.fn(async () => undefined),
}));

vi.mock('ioredis', () => {
  const kv     = new Map();
  const hashes = new Map();
  const zsets  = new Map();

  function getHash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }
  function getZset(key) {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  }

  const client = {
    get: vi.fn(async (k) => kv.get(k) ?? null),
    set: vi.fn(async (k, v) => { kv.set(k, v); return 'OK'; }),
    incr: vi.fn(async (k) => {
      const next = (Number(kv.get(k)) || 0) + 1;
      kv.set(k, String(next));
      return next;
    }),
    hset: vi.fn(async (k, obj) => {
      const h = getHash(k);
      for (const [f, v] of Object.entries(obj)) h.set(f, v);
      return 1;
    }),
    hgetall: vi.fn(async (k) => {
      const h = hashes.get(k);
      if (!h || h.size === 0) return {};
      return Object.fromEntries(h);
    }),
    zadd: vi.fn(async (k, score, member) => {
      getZset(k).set(member, score);
      return 1;
    }),
    zrangebyscore: vi.fn(async (k, from, to, _limitKw, _offset, limit) => {
      const z = getZset(k);
      const sorted = [...z.entries()]
        .filter(([, score]) => score >= from && score <= to)
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m);
      return limit ? sorted.slice(0, limit) : sorted;
    }),
    pipeline: vi.fn(() => {
      const ops = [];
      const pipe = {
        hset: vi.fn((...args) => { ops.push(['hset', args]); return pipe; }),
        zadd: vi.fn((...args) => { ops.push(['zadd', args]); return pipe; }),
        set:  vi.fn((...args) => { ops.push(['set',  args]); return pipe; }),
        hgetall: vi.fn((...args) => { ops.push(['hgetall', args]); return pipe; }),
        exec: vi.fn(async () => {
          const results = [];
          for (const [cmd, args] of ops) {
            const result = await client[cmd](...args);
            results.push([null, result]);
          }
          return results;
        }),
      };
      return pipe;
    }),
  };

  return { default: vi.fn(() => client) };
});

const { recordAuditEvent, queryAuditEvents, verifyChain, exportAuditEvents } =
  await import('../engine/audit-log.js');

const TENANT = 'tenant-audit-test';

function baseEvent(overrides = {}) {
  return {
    actorId: 'k_abc123',
    action: 'workflow.submitted',
    resourceType: 'workflow',
    resourceId: 'wf-1',
    detail: { task: 'do the thing' },
    ...overrides,
  };
}

describe('recordAuditEvent()', () => {
  it('appends an event with prevHash = "" for the first event in a tenant chain', async () => {
    const event = await recordAuditEvent(TENANT, baseEvent());
    expect(event.prevHash).toBe('');
    expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('links each new event\'s prevHash to the previous event\'s hash', async () => {
    const first  = await recordAuditEvent(TENANT, baseEvent({ resourceId: 'wf-2' }));
    const second = await recordAuditEvent(TENANT, baseEvent({ resourceId: 'wf-3', action: 'workflow.cancelled' }));
    expect(second.prevHash).toBe(first.hash);
  });

  it('rejects a call missing required fields', async () => {
    await expect(recordAuditEvent(TENANT, { actorId: 'k_x' })).rejects.toThrow(/requires/);
  });
});

describe('queryAuditEvents()', () => {
  it('returns events oldest-first and filters by action', async () => {
    const tenant = 'tenant-query-test';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'a', action: 'workflow.submitted' }));
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'b', action: 'workflow.cancelled' }));
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'c', action: 'workflow.submitted' }));

    const all = await queryAuditEvents(tenant);
    expect(all.map(e => e.resourceId)).toEqual(['a', 'b', 'c']);

    const submitted = await queryAuditEvents(tenant, { action: 'workflow.submitted' });
    expect(submitted.map(e => e.resourceId)).toEqual(['a', 'c']);
  });

  it('filters by resourceType', async () => {
    const tenant = 'tenant-query-rt';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'k_1', resourceType: 'apiKey', action: 'key.created' }));
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'wf-1', resourceType: 'workflow' }));

    const keys = await queryAuditEvents(tenant, { resourceType: 'apiKey' });
    expect(keys).toHaveLength(1);
    expect(keys[0].resourceId).toBe('k_1');
  });
});

describe('verifyChain()', () => {
  it('accepts an untampered chain', async () => {
    const tenant = 'tenant-verify-ok';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'a' }));
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'b' }));

    const events = await queryAuditEvents(tenant);
    expect(verifyChain(events).ok).toBe(true);
  });

  it('detects a mutated field', async () => {
    const tenant = 'tenant-verify-tamper';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'a' }));
    const events = await queryAuditEvents(tenant);

    events[0].detail = { task: 'tampered' };
    const result = verifyChain(events);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(events[0].id);
  });

  it('detects a forged signature even if hash matches', async () => {
    const tenant = 'tenant-verify-forged-sig';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'a' }));
    const events = await queryAuditEvents(tenant);

    events[0].sig = 'f'.repeat(64);
    expect(verifyChain(events).ok).toBe(false);
  });
});

describe('exportAuditEvents()', () => {
  it('JSON export carries a chainValid flag alongside the events', async () => {
    const tenant = 'tenant-export-json';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'a' }));

    const result = await exportAuditEvents(tenant, { format: 'json' });
    expect(result.contentType).toBe('application/json');
    const parsed = JSON.parse(result.body);
    expect(parsed.chainValid).toBe(true);
    expect(parsed.events).toHaveLength(1);
  });

  it('CSV export has a header row plus one row per event', async () => {
    const tenant = 'tenant-export-csv';
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'a' }));
    await recordAuditEvent(tenant, baseEvent({ resourceId: 'b' }));

    const result = await exportAuditEvents(tenant, { format: 'csv' });
    expect(result.contentType).toBe('text/csv');
    const lines = result.body.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 events
    expect(lines[0]).toContain('resourceId');
  });
});
