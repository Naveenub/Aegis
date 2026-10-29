/**
 * tests/sso.test.js — engine/sso.js OIDC config + login flow against a loopback IdP
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('ioredis', async () => (await import('./helpers/fake-redis.js')).ioredisMock);

import { fakeRedis } from './helpers/fake-redis.js';
import { startFakeIdp } from './helpers/fake-idp.js';
import { setSsoConfig, getSsoConfig, deleteSsoConfig, beginLogin, completeLogin, SsoError } from '../engine/sso.js';
import { createUser, updateUser, getUserByEmail } from '../engine/user-store.js';

let idp;
beforeAll(async () => {
  process.env.AEGIS_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
  process.env.AEGIS_PUBLIC_URL = 'https://aegis.test';
  idp = await startFakeIdp({ clientId: 'cid' });
});
afterAll(() => idp.close());
beforeEach(() => { fakeRedis._reset(); idp.state.tokenStatus = 200; });

const cfg = (over = {}) => ({
  issuer: idp.issuer, clientId: 'cid', clientSecret: 's3cret',
  allowedDomains: ['acme.com'], jitRole: 'viewer', ...over,
});

/** Run begin → (IdP) → complete with the given ID-token claims. */
async function login(claims, { cookieState } = {}) {
  const { url, state } = await beginLogin('acme');
  idp.willIssue(claims, url);
  return completeLogin({ code: 'authcode', state, cookieState: cookieState ?? state });
}
const ok = { sub: 'sub-1', email: 'alice@acme.com', email_verified: true, name: 'Alice' };

describe('setSsoConfig / getSsoConfig', () => {
  it('seals the client secret and never returns it', async () => {
    const view = await setSsoConfig('acme', cfg());
    expect(view).toMatchObject({ issuer: idp.issuer, clientId: 'cid', jitRole: 'viewer', enabled: true, hasSecret: true });
    expect(JSON.stringify(view)).not.toContain('s3cret');
    expect(fakeRedis._kv.get('aegis:sso:acme')).not.toContain('s3cret');
    expect(JSON.stringify(await getSsoConfig('acme'))).not.toContain('clientSecret');
  });

  it('keeps the stored secret when updating without one', async () => {
    await setSsoConfig('acme', cfg());
    const sealed = JSON.parse(fakeRedis._kv.get('aegis:sso:acme')).clientSecret;
    await setSsoConfig('acme', cfg({ clientSecret: undefined, enabled: false }));
    const after = JSON.parse(fakeRedis._kv.get('aegis:sso:acme'));
    expect(after.clientSecret).toBe(sealed);
    expect(after.enabled).toBe(false);
  });

  it.each([
    [{ issuer: 'http://idp.example.com' }, /https/],
    [{ issuer: 'not a url' }, /URL/],
    [{ clientId: '' }, /clientId/],
    [{ allowedDomains: ['bad domain'] }, /domain/],
    [{ jitRole: 'admin' }, /cannot be "admin"/],
    [{ jitRole: 'root' }, /Invalid jitRole/],
    [{ jitRole: 'viewer', allowedDomains: [] }, /allowedDomains/],
  ])('rejects invalid config %j', async (over, msg) => {
    await expect(setSsoConfig('acme', cfg(over))).rejects.toThrow(msg);
  });

  it('requires a secret on first set; get/delete round-trip', async () => {
    await expect(setSsoConfig('acme', cfg({ clientSecret: undefined }))).rejects.toThrow(/clientSecret/);
    await setSsoConfig('acme', cfg());
    await deleteSsoConfig('acme');
    expect(await getSsoConfig('acme')).toBeNull();
  });
});

describe('beginLogin', () => {
  it('builds an authorization-code + PKCE request and stores a single-use transaction', async () => {
    await setSsoConfig('acme', cfg());
    const { url, state } = await beginLogin('acme');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(`${idp.issuer}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      response_type: 'code', client_id: 'cid', redirect_uri: 'https://aegis.test/auth/sso/callback',
      scope: 'openid email profile', state, code_challenge_method: 'S256',
    });
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('refuses when SSO is absent or disabled', async () => {
    await expect(beginLogin('acme')).rejects.toMatchObject({ code: 'not_configured' });
    await setSsoConfig('acme', cfg({ enabled: false }));
    await expect(beginLogin('acme')).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('completeLogin', () => {
  beforeEach(() => setSsoConfig('acme', cfg()));

  it('JIT-provisions an allowed domain at jitRole, sends PKCE verifier + secret, binds the IdP subject', async () => {
    const { user, tenantId } = await login(ok);
    expect(tenantId).toBe('acme');
    expect(user).toMatchObject({ email: 'alice@acme.com', role: 'viewer', idpSub: 'sub-1', name: 'Alice' });
    expect(user.lastLoginAt).toBeTypeOf('number');
    expect(idp.state.lastTokenBody).toMatchObject({ grant_type: 'authorization_code', code: 'authcode', client_secret: 's3cret' });
    expect(idp.state.lastTokenBody.code_verifier).toBeTruthy();
  });

  it('keeps the role of a pre-provisioned user and binds their subject on first login', async () => {
    const pre = await createUser('acme', { email: 'alice@acme.com', role: 'admin' });
    const { user } = await login(ok);
    expect(user).toMatchObject({ userId: pre.userId, role: 'admin', idpSub: 'sub-1' });
  });

  it('rejects a different IdP subject for the same email', async () => {
    await createUser('acme', { email: 'alice@acme.com', role: 'member', idpSub: 'sub-1' });
    await expect(login({ ...ok, sub: 'someone-else' })).rejects.toMatchObject({ code: 'denied', email: 'alice@acme.com' });
  });

  it('rejects disabled users, unverified emails and domains outside the allow-list', async () => {
    const u = await createUser('acme', { email: 'alice@acme.com', role: 'member' });
    await updateUser('acme', u.userId, { disabled: true });
    await expect(login(ok)).rejects.toMatchObject({ code: 'denied' });
    await expect(login({ ...ok, email_verified: false })).rejects.toMatchObject({ code: 'denied' });
    await expect(login({ ...ok, email: 'mallory@evil.com' })).rejects.toMatchObject({ code: 'denied' });
    expect(await getUserByEmail('acme', 'mallory@evil.com')).toBeNull();
  });

  it('does not auto-provision when jitRole is unset', async () => {
    await setSsoConfig('acme', cfg({ jitRole: null }));
    await expect(login(ok)).rejects.toMatchObject({ code: 'denied' });
    expect(await getUserByEmail('acme', 'alice@acme.com')).toBeNull();
  });

  it('rejects a state that does not match the browser cookie, and a replayed state', async () => {
    await expect(login(ok, { cookieState: 'forged' })).rejects.toMatchObject({ code: 'state_mismatch' });
    const { url, state } = await beginLogin('acme');
    idp.willIssue(ok, url);
    await completeLogin({ code: 'c', state, cookieState: state });
    await expect(completeLogin({ code: 'c', state, cookieState: state })).rejects.toMatchObject({ code: 'state_expired' });
  });

  it('fails on a token-endpoint error', async () => {
    idp.state.tokenStatus = 400;
    await expect(login(ok)).rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('rejects an ID token with a wrong nonce or a bad signature', async () => {
    const { url, state } = await beginLogin('acme');
    idp.willIssue(ok, url);
    idp.state.nonce = 'replayed-nonce';
    await expect(completeLogin({ code: 'c', state, cookieState: state })).rejects.toMatchObject({ code: 'invalid_id_token' });

    const second = await beginLogin('acme');
    idp.willIssue(ok, second.url);
    await idp.signWithOtherKey();
    const err = await completeLogin({ code: 'c', state: second.state, cookieState: second.state }).catch((e) => e);
    expect(err).toBeInstanceOf(SsoError);
    expect(err.code).toBe('invalid_id_token');
  });
});
