/**
 * tests/audit-identity.test.js — identity fields on audit events keep the hash chain valid
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => { process.env.AEGIS_AUDIT_SIGNING_KEY = 'test-signing-key'; });
vi.mock('ioredis', async () => (await import('./helpers/fake-redis.js')).ioredisMock);
vi.mock('../engine/lock.js', () => ({ acquireLock: vi.fn(async () => 'l'), releaseLock: vi.fn(async () => {}) }));

import { createHash, createHmac } from 'crypto';
import { fakeRedis } from './helpers/fake-redis.js';
import { recordAuditEvent, queryAuditEvents, verifyChain, exportAuditEvents } from '../engine/audit-log.js';

beforeEach(() => fakeRedis._reset());
const base = { action: 'workflow.submitted', resourceType: 'workflow', resourceId: 'wf1' };

describe('audit identity', () => {
  it('persists actorEmail / actorRole / ip and the chain verifies', async () => {
    await recordAuditEvent('acme', { ...base, actorId: 'u_1', actorType: 'user', actorEmail: 'a@acme.com', actorRole: 'admin', ip: '1.2.3.4' });
    await recordAuditEvent('acme', { ...base, actorId: 'k1', actorRole: 'member' });
    const events = await queryAuditEvents('acme');
    expect(events[0]).toMatchObject({ actorType: 'user', actorEmail: 'a@acme.com', actorRole: 'admin', ip: '1.2.3.4' });
    expect(events[1].actorEmail).toBeUndefined();
    expect(verifyChain(events)).toEqual({ ok: true, brokenAt: null });
  });

  it('detects tampering with an identity field', async () => {
    await recordAuditEvent('acme', { ...base, actorId: 'u_1', actorType: 'user', actorEmail: 'a@acme.com' });
    const [e] = await queryAuditEvents('acme');
    expect(verifyChain([{ ...e, actorEmail: 'someone-else@acme.com' }]).ok).toBe(false);
    expect(verifyChain([{ ...e, actorEmail: undefined }]).ok).toBe(false);
  });

  it('still verifies events written before identity fields existed', () => {
    // Hand-built with the ORIGINAL canonical form (no identity keys at all).
    const core = { id: 'acme-1', ts: 1700000000000, tenantId: 'acme', actorId: 'env-key', actorType: 'api-key',
      action: 'key.created', resourceType: 'apiKey', resourceId: 'k1', detail: { label: 'x' } };
    const hash = createHash('sha256').update('' + '|' + JSON.stringify(core)).digest('hex');
    const sig = createHmac('sha256', 'test-signing-key').update(hash).digest('hex');
    const legacy = { ...core, actorEmail: undefined, actorRole: undefined, ip: undefined, prevHash: '', hash, sig };
    expect(verifyChain([legacy])).toEqual({ ok: true, brokenAt: null });
  });

  it('exports identity columns in CSV (blank when absent)', async () => {
    await recordAuditEvent('acme', { ...base, actorId: 'u_1', actorType: 'user', actorEmail: 'a@acme.com' });
    await recordAuditEvent('acme', { ...base, actorId: 'k1' });
    const { body, chainValid } = await exportAuditEvents('acme', { format: 'csv' });
    const [header, r1, r2] = body.split('\n');
    expect(header).toContain('"actorEmail","actorRole","ip"'.replaceAll('"', ''));
    expect(r1).toContain('"a@acme.com"');
    expect(r2).not.toContain('undefined');
    expect(chainValid).toBe(true);
  });
});
