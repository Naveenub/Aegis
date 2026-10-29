/**
 * tests/user-store.test.js — users, sessions and one-time SSO codes (fake Redis)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ioredis', async () => (await import('./helpers/fake-redis.js')).ioredisMock);

import { fakeRedis } from './helpers/fake-redis.js';
import {
  createUser, getUser, getUserByEmail, listUsers, updateUser,
  createSession, resolveSession, deleteSession, createSsoCode, redeemSsoCode,
  SESSION_PREFIX, sessionTtlSeconds,
} from '../engine/user-store.js';

beforeEach(() => fakeRedis._reset());

describe('users', () => {
  it('creates a user, normalises email and rejects a duplicate (case-insensitive)', async () => {
    const u = await createUser('acme', { email: ' Alice@Acme.com ', role: 'member' });
    expect(u).toMatchObject({ email: 'alice@acme.com', role: 'member', tenantId: 'acme', disabledAt: null });
    expect(u.userId).toMatch(/^u_[0-9a-f]{12}$/);
    await expect(createUser('acme', { email: 'ALICE@acme.com', role: 'viewer' })).rejects.toMatchObject({ code: 'USER_EXISTS' });
    // same email in another tenant is a different user
    await expect(createUser('other', { email: 'alice@acme.com', role: 'viewer' })).resolves.toBeTruthy();
  });

  it('validates email and role', async () => {
    await expect(createUser('acme', { email: 'nope', role: 'member' })).rejects.toThrow(/valid email/);
    await expect(createUser('acme', { email: 'a@b.co', role: 'root' })).rejects.toThrow(/Invalid role/);
    await expect(createUser('bad tenant!', { email: 'a@b.co', role: 'member' })).rejects.toThrow(/Invalid tenantId/);
  });

  it('looks up by id and email, lists newest first', async () => {
    const a = await createUser('acme', { email: 'a@acme.com', role: 'viewer' });
    await new Promise((r) => setTimeout(r, 2));
    const b = await createUser('acme', { email: 'b@acme.com', role: 'viewer' });
    expect((await getUser('acme', a.userId)).email).toBe('a@acme.com');
    expect((await getUserByEmail('acme', 'B@ACME.com')).userId).toBe(b.userId);
    expect(await getUserByEmail('acme', 'zzz@acme.com')).toBeNull();
    expect((await listUsers('acme')).map((u) => u.email)).toEqual(['b@acme.com', 'a@acme.com']);
  });

  it('updates role / disabled / idpSub and returns null for an unknown user', async () => {
    const u = await createUser('acme', { email: 'a@acme.com', role: 'viewer' });
    expect((await updateUser('acme', u.userId, { role: 'admin' })).role).toBe('admin');
    const off = await updateUser('acme', u.userId, { disabled: true });
    expect(off.disabledAt).toBeTypeOf('number');
    expect((await updateUser('acme', u.userId, { disabled: false })).disabledAt).toBeNull();
    expect((await updateUser('acme', u.userId, { idpSub: 's1' })).idpSub).toBe('s1');
    await expect(updateUser('acme', u.userId, { role: 'root' })).rejects.toThrow(/Invalid role/);
    expect(await updateUser('acme', 'u_missing', { role: 'admin' })).toBeNull();
  });
});

describe('sessions', () => {
  it('stores only a hash of the token and resolves it to the live user', async () => {
    const u = await createUser('acme', { email: 'a@acme.com', role: 'member' });
    const { token, expiresAt } = await createSession('acme', u.userId);
    expect(token.startsWith(SESSION_PREFIX)).toBe(true);
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect([...fakeRedis._kv.keys()].some((k) => k.includes(token))).toBe(false);
    expect((await resolveSession(token)).userId).toBe(u.userId);
  });

  it('picks up role changes immediately and dies when the user is disabled', async () => {
    const u = await createUser('acme', { email: 'a@acme.com', role: 'viewer' });
    const { token } = await createSession('acme', u.userId);
    await updateUser('acme', u.userId, { role: 'admin' });
    expect((await resolveSession(token)).role).toBe('admin');
    await updateUser('acme', u.userId, { disabled: true });
    expect(await resolveSession(token)).toBeNull();
  });

  it('rejects unknown tokens and logout deletes the session', async () => {
    expect(await resolveSession('aegs_nope')).toBeNull();
    const u = await createUser('acme', { email: 'a@acme.com', role: 'viewer' });
    const { token } = await createSession('acme', u.userId);
    await deleteSession(token);
    expect(await resolveSession(token)).toBeNull();
  });

  it('honours AEGIS_SESSION_TTL_HOURS (default 8h, ignores junk)', () => {
    delete process.env.AEGIS_SESSION_TTL_HOURS;
    expect(sessionTtlSeconds()).toBe(8 * 3600);
    process.env.AEGIS_SESSION_TTL_HOURS = '2';
    expect(sessionTtlSeconds()).toBe(7200);
    process.env.AEGIS_SESSION_TTL_HOURS = 'abc';
    expect(sessionTtlSeconds()).toBe(8 * 3600);
    delete process.env.AEGIS_SESSION_TTL_HOURS;
  });
});

describe('SSO exchange codes', () => {
  it('can be redeemed exactly once', async () => {
    const code = await createSsoCode('acme', 'u_1');
    expect(await redeemSsoCode(code)).toEqual({ userId: 'u_1', tenantId: 'acme' });
    expect(await redeemSsoCode(code)).toBeNull();
    expect(await redeemSsoCode(undefined)).toBeNull();
  });
});
