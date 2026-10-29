/**
 * tests/audit-zero-retention.test.js — zero-retention tenants never get task text in the (unprunable) audit log
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.AEGIS_AUDIT_SIGNING_KEY = 'test-signing-key'; });
vi.mock('ioredis', async () => (await import('./helpers/fake-redis.js')).ioredisMock);
vi.mock('../engine/lock.js', () => ({ acquireLock: vi.fn(async () => 'l'), releaseLock: vi.fn(async () => {}) }));
const zero = new Set();
vi.mock('../engine/retention-policy.js', () => ({
  REDACTED: '[redacted: zero-retention]',
  isZeroRetention: vi.fn(async (t) => zero.has(t)),
}));

import { fakeRedis } from './helpers/fake-redis.js';
import { recordAuditEvent, queryAuditEvents, verifyChain } from '../engine/audit-log.js';

beforeEach(() => { fakeRedis._reset(); zero.clear(); });
const ev = (detail) => ({ actorId: 'k1', action: 'workflow.submitted', resourceType: 'workflow', resourceId: 'wf1', detail });

describe('audit log task excerpt', () => {
  it('is kept for normal tenants', async () => {
    await recordAuditEvent('acme', ev({ task: 'fix the login bug', priority: 1 }));
    expect((await queryAuditEvents('acme'))[0].detail.task).toBe('fix the login bug');
  });

  it('is redacted for zero-retention tenants, other detail kept, chain valid', async () => {
    zero.add('acme');
    await recordAuditEvent('acme', ev({ task: 'secret customer prompt', priority: 1 }));
    await recordAuditEvent('acme', { ...ev({}), action: 'key.created' });
    const events = await queryAuditEvents('acme');
    expect(JSON.stringify(events)).not.toContain('secret customer prompt');
    expect(events.find((e) => e.action === 'workflow.submitted').detail).toEqual({ task: '[redacted: zero-retention]', priority: 1 });
    expect(verifyChain(events).ok).toBe(true);
  });
});
