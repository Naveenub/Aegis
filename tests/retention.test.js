/**
 * tests/retention.test.js
 *
 * Retention policy, zero-retention mode and the retention sweeper.
 * Redis is replaced by a small in-memory fake; tenant-registry and
 * vector-memory are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

// ─── in-memory redis ──────────────────────────────────────────────────────────
const db = vi.hoisted(() => {
  const state = { kv: new Map(), hashes: new Map(), zsets: new Map() };
  const H = (k) => { if (!state.hashes.has(k)) state.hashes.set(k, new Map()); return state.hashes.get(k); };
  const Z = (k) => { if (!state.zsets.has(k)) state.zsets.set(k, new Map()); return state.zsets.get(k); };
  const del = (...keys) => { for (const k of keys.flat()) { state.kv.delete(k); state.hashes.delete(k); state.zsets.delete(k); } return 1; };
  const client = {
    on: () => {},
    get: async (k) => state.kv.get(k) ?? null,
    set: async (k, v) => { state.kv.set(k, v); return 'OK'; },
    del: async (...k) => del(...k),
    hset: async (k, f, v) => {
      if (typeof f === 'object') for (const [a, b] of Object.entries(f)) H(k).set(a, String(b)); else H(k).set(f, v);
      return 1;
    },
    hgetall: async (k) => Object.fromEntries(state.hashes.get(k) ?? []),
    hkeys: async (k) => [...(state.hashes.get(k)?.keys() ?? [])],
    zadd: async (k, s, m) => { Z(k).set(m, s); return 1; },
    zrem: async (k, ...m) => { for (const x of m) Z(k).delete(x); return 1; },
    zrange: async (k) => [...(state.zsets.get(k)?.keys() ?? [])],
    zrangebyscore: async (k, _min, max) => [...(state.zsets.get(k) ?? [])].filter(([, s]) => s <= Number(max)).map(([m]) => m),
    scan: async (_c, _m, pattern) => {
      const prefix = pattern.replace('*', '');
      return ['0', [...state.kv.keys()].filter((k) => k.startsWith(prefix))];
    },
    pipeline: () => {
      const ops = [];
      const p = new Proxy({}, {
        get: (_t, name) => (name === 'exec'
          ? async () => { const out = []; for (const [n, a] of ops) out.push([null, await client[n](...a)]); return out; }
          : (...a) => { ops.push([name, a]); return p; }),
      });
      return p;
    },
  };
  return { state, client };
});
vi.mock('ioredis', () => ({ default: vi.fn(() => db.client) }));

// ─── tenant-registry / vector-memory / quota mocks ────────────────────────────
const overrides = {};
vi.mock('../engine/tenant-registry.js', () => ({
  listTenants: vi.fn(async () => Object.keys(overrides)),
  getRetentionConfig: vi.fn(async (t) => ({ jobsDays: null, workflowsDays: null, memoryDays: null, zeroRetention: false, ...overrides[t] })),
}));
const evict = vi.fn(async () => 0);
vi.mock('../engine/vector-memory.js', () => ({ evictExpiredMemory: evict }));
vi.mock('../engine/tenant-quota.js', () => ({
  assertJobQuota: vi.fn(), trackJobQueued: vi.fn(), trackJobDone: vi.fn(),
}));

const { parseRetentionUpdate, getEffectivePolicy, invalidatePolicy, REDACTED } = await import('../engine/retention-policy.js');
const { runRetentionSweep, purgeTenantContent } = await import('../engine/retention.js');
const { scrubWorkflowContent } = await import('../engine/workflow-purge.js');
const { updateJob, createJob, getJob } = await import('../engine/job-store.js');

// ─── fixtures ─────────────────────────────────────────────────────────────────
function seedWorkflow(id, { tenant = 'acme', status = 'completed', ageDays = 1 } = {}) {
  const at = NOW - ageDays * DAY;
  db.state.kv.set(`aegis:workflow:meta:${id}`, JSON.stringify({ id, tenantId: tenant, status, createdAt: at, completedAt: status === 'running' ? undefined : at, reason: 'secret reason' }));
  db.state.hashes.set(`aegis:workflow:${id}`, new Map([['s1', JSON.stringify({ id: 's1', description: 'fix the login bug in acme-billing', status: 'completed', lastPatch: 'diff --git ...' })]]));
  db.state.hashes.set(`aegis:trace:${id}:span:s1`, new Map([['patch', 'diff --git ...']]));
  db.state.zsets.set(`aegis:trace:${id}:spans`, new Map([['s1', at]]));
  db.state.kv.set(`aegis:trace:${id}:meta`, '{}');
  db.state.zsets.set('aegis:traces:index', new Map([...(db.state.zsets.get('aegis:traces:index') ?? []), [id, at]]));
  db.state.kv.set(`aegis:review:${id}:s1`, '{"error":"stack trace"}');
  db.state.zsets.set('aegis:review:index', new Map([...(db.state.zsets.get('aegis:review:index') ?? []), [`aegis:review:${id}:s1`, at]]));
}
const has = (k) => db.state.kv.has(k) || db.state.hashes.has(k) || db.state.zsets.has(k);

beforeEach(() => {
  db.state.kv.clear(); db.state.hashes.clear(); db.state.zsets.clear();
  for (const k of Object.keys(overrides)) delete overrides[k];
  evict.mockClear();
  invalidatePolicy();
});

// ─── tests ────────────────────────────────────────────────────────────────────
describe('parseRetentionUpdate', () => {
  it('accepts in-range integers, null (reset) and booleans', () => {
    expect(parseRetentionUpdate({ jobsDays: 7, memoryDays: null, zeroRetention: true }).updates)
      .toEqual({ jobsDays: 7, memoryDays: null, zeroRetention: true });
  });
  it.each([
    [{ jobsDays: 0 }], [{ jobsDays: 366 }], [{ jobsDays: 1.5 }], [{ jobsDays: '30' }],
    [{ zeroRetention: 'yes' }], [{ auditDays: 5 }], [{}], [null], [[]],
  ])('rejects %j', (body) => {
    expect(parseRetentionUpdate(body).error).toBeTruthy();
  });
});

describe('getEffectivePolicy', () => {
  it('merges tenant overrides over platform defaults', async () => {
    overrides.acme = { jobsDays: 7, zeroRetention: true };
    const p = await getEffectivePolicy('acme');
    expect(p).toMatchObject({ jobsDays: 7, workflowsDays: 90, memoryDays: 30, zeroRetention: true });
  });
});

describe('runRetentionSweep', () => {
  it('purges only terminal workflows past the tenant limit, with every related key', async () => {
    overrides.acme = { workflowsDays: 30 };
    seedWorkflow('old', { ageDays: 45 });
    seedWorkflow('recent', { ageDays: 5 });
    seedWorkflow('stuck', { status: 'running', ageDays: 400 });

    const r = await runRetentionSweep({ now: NOW });

    expect(r.tenants.acme.workflowsPurged).toBe(1);
    for (const k of ['aegis:workflow:old', 'aegis:workflow:meta:old', 'aegis:trace:old:meta', 'aegis:trace:old:span:s1', 'aegis:review:old:s1']) expect(has(k)).toBe(false);
    expect(db.state.zsets.get('aegis:traces:index').has('old')).toBe(false);
    expect(db.state.zsets.get('aegis:review:index').has('aegis:review:old:s1')).toBe(false);
    expect(has('aegis:workflow:meta:recent')).toBe(true);
    expect(has('aegis:workflow:meta:stuck')).toBe(true); // never touch running workflows
    expect(r.errors).toEqual([]);
  });

  it('deletes job records older than jobsDays and evicts memory per policy', async () => {
    overrides.acme = { jobsDays: 10, memoryDays: 3 };
    db.state.zsets.set('aegis:jobs:index:acme', new Map([['j-old', NOW - 11 * DAY], ['j-new', NOW - 1 * DAY]]));
    db.state.hashes.set('aegis:job:acme:j-old', new Map([['status', 'completed']]));
    db.state.hashes.set('aegis:job:acme:j-new', new Map([['status', 'completed']]));

    const r = await runRetentionSweep({ now: NOW });

    expect(r.tenants.acme.jobs).toBe(1);
    expect(has('aegis:job:acme:j-old')).toBe(false);
    expect(has('aegis:job:acme:j-new')).toBe(true);
    expect(evict).toHaveBeenCalledWith('acme', 3 * DAY);
  });

  it('zero-retention tenants: recent finished workflows are scrubbed (skeleton kept) and all memory is purged', async () => {
    overrides.acme = { zeroRetention: true };
    seedWorkflow('w1', { ageDays: 0 });

    const r = await runRetentionSweep({ now: NOW });

    expect(r.tenants.acme.workflowsScrubbed).toBe(1);
    const step = JSON.parse(db.state.hashes.get('aegis:workflow:w1').get('s1'));
    expect(step).toMatchObject({ id: 's1', status: 'completed', description: REDACTED, lastPatch: null });
    expect(JSON.parse(db.state.kv.get('aegis:workflow:meta:w1'))).toMatchObject({ status: 'completed', reason: REDACTED });
    expect(has('aegis:trace:w1:span:s1')).toBe(false);
    expect(has('aegis:review:w1:s1')).toBe(false);
    expect(evict).toHaveBeenCalledWith('acme', 0);
  });

  it('dry-run reports but changes nothing', async () => {
    overrides.acme = { workflowsDays: 1 };
    seedWorkflow('old', { ageDays: 10 });
    const r = await runRetentionSweep({ now: NOW, dryRun: true });
    expect(r.tenants.acme.workflowsPurged).toBe(1);
    expect(has('aegis:workflow:meta:old')).toBe(true);
    expect(evict).not.toHaveBeenCalled();
  });

  it("does not touch another tenant's workflows", async () => {
    overrides.acme = { workflowsDays: 1 };
    overrides.other = { workflowsDays: 365 };
    seedWorkflow('theirs', { tenant: 'other', ageDays: 10 });
    await runRetentionSweep({ now: NOW });
    expect(has('aegis:workflow:meta:theirs')).toBe(true);
  });
});

describe('purgeTenantContent', () => {
  it('removes finished workflows, jobs and memory for the tenant only; skips active ones', async () => {
    seedWorkflow('done', { ageDays: 0 });
    seedWorkflow('live', { status: 'running' });
    seedWorkflow('theirs', { tenant: 'other' });
    db.state.zsets.set('aegis:jobs:index:acme', new Map([['j1', NOW]]));
    db.state.hashes.set('aegis:job:acme:j1', new Map([['status', 'completed']]));

    const r = await purgeTenantContent('acme');

    expect(r).toMatchObject({ workflows: 1, skippedActive: 1, jobs: 1 });
    expect(has('aegis:workflow:meta:done')).toBe(false);
    expect(has('aegis:workflow:meta:live')).toBe(true);
    expect(has('aegis:workflow:meta:theirs')).toBe(true);
    expect(has('aegis:job:acme:j1')).toBe(false);
    expect(evict).toHaveBeenCalledWith('acme', 0);
  });
});

describe('scrubWorkflowContent', () => {
  it('returns false-ish for a workflow that does not exist', async () => {
    expect(await scrubWorkflowContent('nope')).toBe(false);
  });
});

describe('job-store under zero-retention', () => {
  const step = { id: 's1', agent: 'coder' };

  it('redacts free-text results but keeps fixed status phrases', async () => {
    overrides.acme = { zeroRetention: true };
    await createJob('j1', step, 'acme');
    await updateJob('j1', { status: 'failed', result: 'AssertionError: expected "secret" to equal ...' }, 'acme');
    expect((await getJob('j1', 'acme')).result).toBe(REDACTED);
    await updateJob('j1', { status: 'completed', result: 'success' }, 'acme');
    expect((await getJob('j1', 'acme')).result).toBe('success');
  });

  it('keeps results untouched for normal tenants', async () => {
    await createJob('j2', step, 'acme');
    await updateJob('j2', { status: 'failed', result: 'AssertionError: boom' }, 'acme');
    expect((await getJob('j2', 'acme')).result).toBe('AssertionError: boom');
  });
});
