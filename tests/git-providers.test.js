import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'crypto';

// In-memory stand-ins for Redis-backed stores.
const creds = new Map();
const repoStatus = {};
vi.mock('../engine/cred-store.js', () => ({
  saveCreds: vi.fn(async (t, p, c) => { creds.set(t, { provider: p, ...c }); }),
  loadCreds: vi.fn(async (t, p) => (creds.get(t)?.provider === p ? creds.get(t) : null)),
  deleteCreds: vi.fn(async (t) => { creds.delete(t); }),
  withCredLock: vi.fn(async (_t, fn) => fn()),
}));
vi.mock('../engine/repo-store.js', () => ({
  setRepoStatus: vi.fn(async (t, s) => { repoStatus[t] = s; }),
}));

const ENV = {
  AEGIS_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AEGIS_OAUTH_STATE_SECRET: 'x'.repeat(40),
  AEGIS_PUBLIC_URL: 'https://aegis.example.com',
  AEGIS_GITLAB_OAUTH_CLIENT_ID: 'glid', AEGIS_GITLAB_OAUTH_CLIENT_SECRET: 'glsec',
  AEGIS_BITBUCKET_OAUTH_CLIENT_ID: 'bbid', AEGIS_BITBUCKET_OAUTH_CLIENT_SECRET: 'bbsec',
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

let reg, vault, state;
beforeEach(async () => {
  Object.assign(process.env, ENV);
  delete process.env.AEGIS_GITLAB_API_URL; delete process.env.AEGIS_GITLAB_WEB_URL;
  creds.clear(); for (const k of Object.keys(repoStatus)) delete repoStatus[k];
  vi.resetModules();
  reg = await import('../engine/providers/index.js');
  vault = await import('../engine/token-vault.js');
  state = await import('../engine/oauth-state.js');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('token-vault', () => {
  it('round-trips and binds ciphertext to its AAD', () => {
    const s = vault.seal('{"a":1}', 'acme:gitlab');
    expect(s).not.toContain('"a"');
    expect(vault.open(s, 'acme:gitlab')).toBe('{"a":1}');
    expect(() => vault.open(s, 'beta:gitlab')).toThrow(); // blob moved to another tenant
  });
  it('rejects tampering and bad keys', () => {
    const s = vault.seal('secret', 'x');
    expect(() => vault.open(s.slice(0, -2) + 'AA', 'x')).toThrow();
    process.env.AEGIS_TOKEN_ENCRYPTION_KEY = 'short';
    expect(vault.tokenVaultConfigured()).toBe(false);
  });
});

describe('oauth-state', () => {
  it('is bound to the provider, tenant, and expiry', () => {
    const st = state.signOAuthState('acme', 'gitlab');
    expect(state.verifyOAuthState(st, 'gitlab').tenantId).toBe('acme');
    expect(() => state.verifyOAuthState(st, 'bitbucket')).toThrow(/Invalid state/);
    expect(() => state.verifyOAuthState(st.slice(0, -2) + 'AA', 'gitlab')).toThrow(/Invalid state/);
    expect(() => state.verifyOAuthState(st, 'gitlab', Date.now() + 11 * 60_000)).toThrow(/expired/);
  });
});

describe('gitlab provider', () => {
  it('requires client creds, redirect URI, state secret and vault key', () => {
    const gl = reg.getProvider('gitlab');
    expect(gl.configured()).toBe(true);
    delete process.env.AEGIS_TOKEN_ENCRYPTION_KEY;
    expect(gl.configured()).toBe(false);
  });

  it('builds an authorize URL with state, scope=api and the callback', () => {
    const u = new URL(reg.getProvider('gitlab').authorizeUrl('S'));
    expect(u.origin + u.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(u.searchParams.get('state')).toBe('S');
    expect(u.searchParams.get('scope')).toBe('api');
    expect(u.searchParams.get('redirect_uri')).toBe('https://aegis.example.com/gitlab/callback');
  });

  it('derives the web base from a self-hosted API URL', () => {
    process.env.AEGIS_GITLAB_API_URL = 'https://git.corp.example/api/v4';
    expect(reg.getProvider('gitlab').webBase()).toBe('https://git.corp.example');
  });

  it('allows subgroup owners but rejects traversal', () => {
    const gl = reg.getProvider('gitlab');
    expect(() => gl.assertRepoName('group/sub', 'proj')).not.toThrow();
    expect(() => gl.assertRepoName('group/../x', 'proj')).toThrow();
    expect(() => gl.assertRepoName('group', 'a b')).toThrow();
  });

  it('lists Developer+ projects, splitting namespace and skipping empty repos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json([
      { path_with_namespace: 'grp/sub/app', default_branch: 'main' },
      { path_with_namespace: 'grp/empty', default_branch: null },
    ])));
    const repos = await reg.getProvider('gitlab').listReposWithToken('tok');
    expect(repos).toEqual([{ fullName: 'grp/sub/app', owner: 'grp/sub', name: 'app', defaultBranch: 'main', archived: false }]);
    expect(fetch.mock.calls[0][0]).toContain('min_access_level=30');
  });

  it('surfaces invalid_grant without echoing the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_grant', refresh_token: 'LEAK' }, 400)));
    const err = await reg.getProvider('gitlab').refresh('r').catch(e => e);
    expect(err.code).toBe('OAUTH_INVALID_GRANT');
    expect(err.message).not.toContain('LEAK');
  });
});

describe('bitbucket provider', () => {
  it('exchanges codes with HTTP Basic client auth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'a', refresh_token: 'r', expires_in: 7200 })));
    const t = await reg.getProvider('bitbucket').exchangeCode('c');
    expect(t).toMatchObject({ accessToken: 'a', refreshToken: 'r' });
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from('bbid:bbsec').toString('base64')}`);
    expect(fetch.mock.calls[0][1].body).toContain('grant_type=authorization_code');
  });

  it('does not follow a pagination link off the API host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({
      values: [{ full_name: 'ws/repo', mainbranch: { name: 'main' }, is_private: true }],
      next: 'https://evil.example/steal',
    })));
    const repos = await reg.getProvider('bitbucket').listReposWithToken('tok');
    expect(repos).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('OAuth token lifecycle', () => {
  const gl = () => reg.getProvider('gitlab');

  it('returns a fresh token without refreshing', async () => {
    creds.set('acme', { provider: 'gitlab', accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() + 3600_000 });
    vi.stubGlobal('fetch', vi.fn());
    expect(await gl().getToken('acme')).toBe('live');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token and stores the rotated refresh token', async () => {
    creds.set('acme', { provider: 'gitlab', accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() + 30_000 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'new', refresh_token: 'r2', expires_in: 7200 })));
    expect(await gl().getToken('acme')).toBe('new');
    expect(creds.get('acme')).toMatchObject({ accessToken: 'new', refreshToken: 'r2' });
  });

  it('keeps the old refresh token when the provider does not rotate it', async () => {
    creds.set('acme', { provider: 'bitbucket', accessToken: 'old', refreshToken: 'keep', expiresAt: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ access_token: 'new', expires_in: 7200 })));
    await reg.getProvider('bitbucket').getToken('acme');
    expect(creds.get('acme').refreshToken).toBe('keep');
  });

  it('drops credentials and marks the repo revoked on invalid_grant', async () => {
    creds.set('acme', { provider: 'gitlab', accessToken: 'old', refreshToken: 'dead', expiresAt: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_grant' }, 400)));
    await expect(gl().getToken('acme')).rejects.toMatchObject({ code: 'PROVIDER_AUTH_REVOKED' });
    expect(creds.has('acme')).toBe(false);
    expect(repoStatus.acme).toBe('revoked');
  });

  it('keeps credentials on a transient refresh failure', async () => {
    creds.set('acme', { provider: 'gitlab', accessToken: 'old', refreshToken: 'r', expiresAt: 0 });
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 503)));
    await expect(gl().getToken('acme')).rejects.toMatchObject({ code: 'OAUTH_EXCHANGE_FAILED' });
    expect(creds.has('acme')).toBe(true);
    expect(repoStatus.acme).toBeUndefined();
  });

  it('treats missing credentials as revoked', async () => {
    await expect(gl().getToken('acme')).rejects.toMatchObject({ code: 'PROVIDER_AUTH_REVOKED' });
  });
});
