import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';

const store = { cfg: null, nonces: new Set(), bound: null, selected: null, creds: null };
const fake = {
  name: 'gitlab', configured: () => true,
  authorizeUrl: (s) => `https://gitlab.example/oauth/authorize?state=${s}`,
  exchangeCode: vi.fn(async () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 7200_000 })),
  getAccount: vi.fn(async () => ({ id: '77', login: 'dev' })),
  listReposWithToken: vi.fn(async () => [{ owner: 'grp/sub', name: 'app', defaultBranch: 'main' }]),
};

vi.mock('../middleware/auth.js', () => ({ requireApiKey: (_q, _s, n) => n(), assertTenantAccess: () => true }));
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent: vi.fn(async () => {}) }));
vi.mock('../engine/github-app.js', () => ({
  githubAppConfigured: () => false, signState: vi.fn(), verifyState: vi.fn(), installUrl: vi.fn(),
  getInstallation: vi.fn(), listInstallationRepos: vi.fn(), userCanAccessInstallation: vi.fn(),
  verifyAppWebhook: vi.fn(), forgetInstallation: vi.fn(),
}));
vi.mock('../engine/tenant-repo.js', () => ({
  ensureTenantRepo: vi.fn(async () => ({})), removeTenantRepoFiles: vi.fn(),
  multiRepoMode: () => true, assertRepoName: vi.fn(),
}));
vi.mock('../engine/repo-store.js', () => ({
  getRepoConfig: vi.fn(async () => store.cfg),
  bindInstallation: vi.fn(), setRepoStatus: vi.fn(), clearRepo: vi.fn(),
  tenantForInstallation: vi.fn(), releaseInstallation: vi.fn(),
  bindProviderAccount: vi.fn(async (t, p, a) => { store.bound = { t, p, a }; }),
  selectRepo: vi.fn(async (t, r) => { store.selected = { t, r }; }),
  consumeStateNonce: vi.fn(async (n) => (store.nonces.has(n) ? false : (store.nonces.add(n), true))),
}));
vi.mock('../engine/cred-store.js', () => ({
  saveCreds: vi.fn(async (t, p, c) => { store.creds = { t, p, c }; }),
  loadCreds: vi.fn(async () => null),
}));
vi.mock('../engine/providers/index.js', () => ({
  PROVIDER_NAMES: ['github', 'gitlab', 'bitbucket'],
  getProvider: (n) => (n === 'gitlab' ? fake : { name: n, configured: () => false }),
}));

let server, base, oauth;
beforeEach(async () => {
  process.env.AEGIS_OAUTH_STATE_SECRET = 'x'.repeat(40);
  delete process.env.AEGIS_POST_CONNECT_URL;
  Object.assign(store, { cfg: null, bound: null, selected: null, creds: null }); store.nonces.clear();
  vi.clearAllMocks();
  vi.resetModules();
  oauth = await import('../engine/oauth-state.js');
  const { repoRouter } = await import('../engine/repo-routes.js');
  const app = express(); app.use(express.json()); app.use(repoRouter);
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise(r => server.close(r)));

const get = (p) => fetch(base + p, { redirect: 'manual' });

describe('POST /tenants/:id/repo/connect', () => {
  const post = (body) => fetch(`${base}/tenants/acme/repo/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  it('returns a provider authorize URL carrying a signed, provider-bound state', async () => {
    const r = await post({ provider: 'gitlab' });
    const { installUrl, provider } = await r.json();
    expect(provider).toBe('gitlab');
    const st = new URL(installUrl).searchParams.get('state');
    expect(oauth.verifyOAuthState(st, 'gitlab').tenantId).toBe('acme');
  });

  it('rejects unknown providers and unconfigured ones', async () => {
    expect((await post({ provider: 'svn' })).status).toBe(400);
    expect((await post({ provider: 'bitbucket' })).status).toBe(501);
  });
});

describe('GET /gitlab/callback', () => {
  const stateFor = (tenant = 'acme', provider = 'gitlab') => oauth.signOAuthState(tenant, provider);

  it('exchanges the code, binds the account, stores tokens, auto-selects a lone repo', async () => {
    const r = await get(`/gitlab/callback?code=abc&state=${stateFor()}`);
    expect(await r.json()).toEqual({ tenantId: 'acme', status: 'connected' });
    expect(fake.exchangeCode).toHaveBeenCalledWith('abc');
    expect(store.bound).toEqual({ t: 'acme', p: 'gitlab', a: { id: '77', login: 'dev' } });
    expect(store.creds).toMatchObject({ t: 'acme', p: 'gitlab', c: { accessToken: 'at', refreshToken: 'rt' } });
    expect(store.selected.r).toMatchObject({ owner: 'grp/sub', repo: 'app', defaultBranch: 'main' });
  });

  it('never returns tokens to the browser', async () => {
    const body = await (await get(`/gitlab/callback?code=abc&state=${stateFor()}`)).json();
    expect(Object.keys(body).sort()).toEqual(['status', 'tenantId']);
  });

  it('rejects a replayed state', async () => {
    const st = stateFor();
    expect((await get(`/gitlab/callback?code=a&state=${st}`)).status).toBe(200);
    const again = await get(`/gitlab/callback?code=a&state=${st}`);
    expect(again.status).toBe(400);
    expect(fake.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('rejects a state issued for another provider, or tampered', async () => {
    expect((await get(`/gitlab/callback?code=a&state=${stateFor('acme', 'bitbucket')}`)).status).toBe(400);
    expect((await get(`/gitlab/callback?code=a&state=${stateFor().slice(0, -2)}AA`)).status).toBe(400);
    expect(fake.exchangeCode).not.toHaveBeenCalled();
  });

  it('does nothing when the user denied consent', async () => {
    const r = await get(`/gitlab/callback?error=access_denied&state=${stateFor()}`);
    expect(r.status).toBe(400);
    expect(store.bound).toBeNull();
  });

  it('maps a failed code exchange to 400 and stores nothing', async () => {
    fake.exchangeCode.mockRejectedValueOnce(Object.assign(new Error('GitLab token request failed (HTTP 400)'), { code: 'OAUTH_EXCHANGE_FAILED' }));
    const r = await get(`/gitlab/callback?code=bad&state=${stateFor()}`);
    expect(r.status).toBe(400);
    expect(store.creds).toBeNull();
  });
});
