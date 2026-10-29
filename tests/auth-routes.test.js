/**
 * tests/auth-routes.test.js — SSO sign-in → session → RBAC → audit, over real HTTP
 * (Express router + loopback OIDC provider; Redis, rate limiter, audit sink and tenant registry faked)
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('ioredis', async () => (await import('./helpers/fake-redis.js')).ioredisMock);
vi.mock('../middleware/rate-limit.js', () => ({ taskRateLimiter: (_q, _s, n) => n() }));
const audit = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent: audit }));
vi.mock('../engine/tenant-registry.js', () => ({
  getStatus: vi.fn(async () => 'active'),
  getTenant: vi.fn(async (id) => (id === 'ghost' ? null : { id })),
}));

import express from 'express';
import { fakeRedis } from './helpers/fake-redis.js';
import { startFakeIdp } from './helpers/fake-idp.js';
import { authRouter } from '../engine/auth-routes.js';
import { createKey } from '../engine/key-store.js';

let idp, srv, base;
beforeAll(async () => {
  process.env.AEGIS_TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
  process.env.AEGIS_ADMIN_KEY = 'operator';
  process.env.AEGIS_DASHBOARD_URL = 'http://dash.test';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  idp = await startFakeIdp({ clientId: 'cid' });
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  await new Promise((r) => { srv = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  process.env.AEGIS_PUBLIC_URL = base;
});
afterAll(async () => { srv.close(); await idp.close(); });
beforeEach(() => { fakeRedis._reset(); audit.mockClear(); });

const call = (method, path, { key, body, headers = {} } = {}) => fetch(base + path, {
  method, redirect: 'manual',
  headers: { 'Content-Type': 'application/json', ...(key && { Authorization: `Bearer ${key}` }), ...headers },
  body: body && JSON.stringify(body),
});
const operator = { 'x-admin-key': 'operator' };
const configureSso = (over = {}) => call('PUT', '/tenants/acme/sso', {
  headers: operator,
  body: { issuer: idp.issuer, clientId: 'cid', clientSecret: 's3cret', allowedDomains: ['acme.com'], jitRole: 'viewer', ...over },
});
const keyFor = async (role) => (await createKey('acme', { role })).rawKey;

/** Full browser journey → returns { token, user }. */
async function ssoLogin(claims = { sub: 's1', email: 'alice@acme.com', email_verified: true, name: 'Alice' }) {
  const start = await call('GET', '/auth/sso/acme/login');
  const cookie = start.headers.getSetCookie()[0].split(';')[0];
  const authorize = start.headers.get('location');
  idp.willIssue(claims, authorize);
  const cb = await call('GET', `/auth/sso/callback?code=abc&state=${new URL(authorize).searchParams.get('state')}`, { headers: { cookie } });
  const frag = new URL(cb.headers.get('location')).hash;
  const code = new URLSearchParams(frag.slice(1)).get('sso_code');
  const ex = await call('POST', '/auth/sso/exchange', { body: { code } });
  return { start, cb, frag, code, ex, ...(ex.ok ? await ex.json() : {}) };
}

describe('SSO config (operator only)', () => {
  it('requires the operator key and an existing tenant; never echoes the secret', async () => {
    expect((await call('PUT', '/tenants/acme/sso', { body: {} })).status).toBe(403);
    expect((await call('PUT', '/tenants/ghost/sso', { headers: operator, body: {} })).status).toBe(404);
    expect((await configureSso({ jitRole: 'admin' })).status).toBe(400);
    const ok = await configureSso();
    expect(ok.status).toBe(200);
    expect(JSON.stringify(await ok.json())).not.toContain('s3cret');
    expect(audit).toHaveBeenCalledWith('acme', expect.objectContaining({ action: 'sso.configured', actorId: 'operator-key' }));
  });

  it('lets a tenant admin read (but not a member), and the operator remove it', async () => {
    await configureSso();
    expect((await call('GET', '/tenants/acme/sso', { key: await keyFor('admin') })).status).toBe(200);
    expect((await call('GET', '/tenants/acme/sso', { key: await keyFor('member') })).status).toBe(403);
    expect((await call('DELETE', '/tenants/acme/sso', { headers: operator })).status).toBe(204);
    expect((await call('GET', '/auth/sso/acme/login')).status).toBe(404);
  });
});

describe('SSO sign-in journey', () => {
  beforeEach(() => configureSso());

  it('redirects to the IdP with PKCE and a state cookie, then yields a working session', async () => {
    const j = await ssoLogin();
    expect(j.start.status).toBe(302);
    expect(j.start.headers.get('location')).toContain('code_challenge_method=S256');
    const cookie = j.start.headers.getSetCookie()[0];
    expect(cookie).toMatch(/aegis_sso_state=.*HttpOnly.*SameSite=Lax/i);
    expect(j.cb.status).toBe(302);
    expect(j.frag).toMatch(/^#sso_code=/);
    expect(j.frag).not.toContain('aegs_'); // the session token never rides in the URL
    expect(j.token).toMatch(/^aegs_/);
    expect(j.user).toMatchObject({ email: 'alice@acme.com', role: 'viewer' });

    const me = await (await call('GET', '/auth/me', { key: j.token })).json();
    expect(me).toMatchObject({ type: 'user', email: 'alice@acme.com', role: 'viewer', tenantId: 'acme', permissions: [] });
  });

  it('audits the login with the user identity and IP', async () => {
    await ssoLogin();
    expect(audit).toHaveBeenCalledWith('acme', expect.objectContaining({
      action: 'auth.login', actorType: 'user', actorEmail: 'alice@acme.com', actorRole: 'viewer', ip: expect.any(String),
    }));
  });

  it('exchange codes are single-use', async () => {
    const j = await ssoLogin();
    const again = await call('POST', '/auth/sso/exchange', { body: { code: j.code } });
    expect(again.status).toBe(400);
  });

  it('sends the browser back with a short error code and audits denials', async () => {
    const j = await ssoLogin({ sub: 'x', email: 'mallory@evil.com', email_verified: true });
    expect(j.frag).toBe('#sso_error=denied');
    expect(audit).toHaveBeenCalledWith('acme', expect.objectContaining({
      action: 'auth.login_denied', actorType: 'anonymous', actorId: 'mallory@evil.com',
    }));
  });

  it('rejects a callback whose state is not backed by the browser cookie (login CSRF)', async () => {
    const start = await call('GET', '/auth/sso/acme/login');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cb = await call('GET', `/auth/sso/callback?code=abc&state=${state}`); // no cookie
    expect(new URL(cb.headers.get('location')).hash).toBe('#sso_error=state_mismatch');
  });

  it('reports IdP-side errors without calling the token endpoint', async () => {
    const cb = await call('GET', '/auth/sso/callback?error=access_denied');
    expect(new URL(cb.headers.get('location')).hash).toBe('#sso_error=idp_error');
  });

  it('logout kills the session and is audited', async () => {
    const { token } = await ssoLogin();
    expect((await call('POST', '/auth/logout', { key: token })).status).toBe(204);
    expect((await call('GET', '/auth/me', { key: token })).status).toBe(403);
    expect(audit).toHaveBeenCalledWith('acme', expect.objectContaining({ action: 'auth.logout', actorEmail: 'alice@acme.com' }));
  });
});

describe('RBAC on user management', () => {
  it('viewer/member sessions and keys get 403; admin key gets through', async () => {
    await configureSso();
    const { token } = await ssoLogin(); // viewer
    expect((await call('GET', '/tenants/acme/users', { key: token })).status).toBe(403);
    expect((await call('GET', '/tenants/acme/users', { key: await keyFor('member') })).status).toBe(403);
    const res = await call('GET', '/tenants/acme/users', { key: await keyFor('admin') });
    expect(res.status).toBe(200);
    expect((await res.json()).users.map((u) => u.email)).toEqual(['alice@acme.com']);
  });

  it('a session cannot reach another tenant', async () => {
    await configureSso();
    const { token } = await ssoLogin();
    await createKey('other', { role: 'admin' });
    expect((await call('GET', '/tenants/other/users', { key: token })).status).toBe(403);
  });

  it('admin provisions, promotes and disables users — each audited with before/after', async () => {
    await configureSso();
    const admin = await keyFor('admin');
    const bad = await call('POST', '/tenants/acme/users', { key: admin, body: { email: 'bob@acme.com', role: 'root' } });
    expect(bad.status).toBe(400);

    const created = await call('POST', '/tenants/acme/users', { key: admin, body: { email: 'bob@acme.com', role: 'member' } });
    expect(created.status).toBe(201);
    const bob = await created.json();
    expect((await call('POST', '/tenants/acme/users', { key: admin, body: { email: 'BOB@acme.com' } })).status).toBe(409);

    const up = await call('PATCH', `/tenants/acme/users/${bob.userId}`, { key: admin, body: { role: 'admin' } });
    expect((await up.json()).role).toBe('admin');
    expect(audit).toHaveBeenCalledWith('acme', expect.objectContaining({
      action: 'user.updated', actorType: 'api-key', actorRole: 'admin', detail: expect.objectContaining({ role: { from: 'member', to: 'admin' } }),
    }));
    expect((await call('PATCH', `/tenants/acme/users/${bob.userId}`, { key: admin, body: {} })).status).toBe(400);
    expect((await call('PATCH', '/tenants/acme/users/u_nope', { key: admin, body: { role: 'viewer' } })).status).toBe(404);
  });

  it('pre-provisioned role survives SSO login, and disabling a user ends their live session', async () => {
    await configureSso();
    const admin = await keyFor('admin');
    const bob = await (await call('POST', '/tenants/acme/users', { key: admin, body: { email: 'bob@acme.com', role: 'admin' } })).json();
    const { token, user } = await ssoLogin({ sub: 'b1', email: 'bob@acme.com', email_verified: true });
    expect(user.role).toBe('admin');
    expect((await call('GET', '/tenants/acme/users', { key: token })).status).toBe(200); // session admin
    await call('PATCH', `/tenants/acme/users/${bob.userId}`, { key: admin, body: { disabled: true } });
    expect((await call('GET', '/auth/me', { key: token })).status).toBe(403);
  });
});

describe('API keys carry roles', () => {
  it('/auth/me reports the key role and permissions', async () => {
    const me = await (await call('GET', '/auth/me', { key: await keyFor('member') })).json();
    expect(me).toMatchObject({ type: 'api-key', role: 'member', permissions: ['workflow.run', 'review.resolve'] });
  });
  it('rejects requests with no credentials', async () => {
    expect((await call('GET', '/auth/me')).status).toBe(401);
  });
});
