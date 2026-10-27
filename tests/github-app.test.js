import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, createVerify, createHmac } from 'crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
});

const ENV = {
  AEGIS_GITHUB_APP_ID: '123', AEGIS_GITHUB_APP_SLUG: 'aegis-app',
  AEGIS_GITHUB_APP_PRIVATE_KEY: privateKey,
  AEGIS_GITHUB_APP_CLIENT_ID: 'cid', AEGIS_GITHUB_APP_CLIENT_SECRET: 'csec',
  AEGIS_GITHUB_APP_WEBHOOK_SECRET: 'whsec',
  AEGIS_OAUTH_STATE_SECRET: 'x'.repeat(40),
};

let app;
beforeEach(async () => {
  Object.assign(process.env, ENV);
  vi.resetModules();
  app = await import('../engine/github-app.js');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('github-app', () => {
  it('reports configured only when everything is set', () => {
    expect(app.githubAppConfigured()).toBe(true);
    delete process.env.AEGIS_GITHUB_APP_SLUG;
    expect(app.githubAppConfigured()).toBe(false);
  });

  it('signs an RS256 app JWT verifiable with the public key', () => {
    const [h, b, s] = app.appJwt().split('.');
    const ok = createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
    expect(JSON.parse(Buffer.from(b, 'base64url').toString()).iss).toBe('123');
  });

  it('round-trips state and rejects tamper / expiry', () => {
    const st = app.signState('acme');
    expect(app.verifyState(st).tenantId).toBe('acme');
    expect(() => app.verifyState(st.slice(0, -2) + 'AA')).toThrow(/Invalid state/);
    expect(() => app.verifyState(st, Date.now() + 11 * 60_000)).toThrow(/expired/);
  });

  it('caches installation tokens per repo and scopes the request', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 201,
      json: async () => ({ token: 'ghs_1', expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await app.getInstallationToken('42', 'repo-a')).toBe('ghs_1');
    expect(await app.getInstallationToken('42', 'repo-a')).toBe('ghs_1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).repositories).toEqual(['repo-a']);
  });

  it('userCanAccessInstallation fails closed without code or when id not listed', async () => {
    expect(await app.userCanAccessInstallation(undefined, '42')).toBe(false);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'u' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ installations: [{ id: 7 }] }) }));
    expect(await app.userCanAccessInstallation('c', '42')).toBe(false);
  });

  it('verifies webhook signatures', () => {
    const body = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(app.verifyAppWebhook(body, sig)).toBe(true);
    expect(app.verifyAppWebhook(body, 'sha256=00')).toBe(false);
    expect(app.verifyAppWebhook(body, undefined)).toBe(false);
  });
});
