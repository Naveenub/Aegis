import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const store = { cfg: null };
vi.mock('../engine/repo-store.js', () => ({
  getRepoConfig: vi.fn(async () => store.cfg),
  patchRepo: vi.fn(async () => {}),
  withRepoLock: vi.fn(async (_t, fn) => fn()),
}));
vi.mock('../engine/providers/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getProvider: (name = 'github') => (name === 'github' ? actual.getProvider('github') : {
      ...actual.getProvider(name),
      getToken: async () => 'oauth_secret',
    }),
  };
});
vi.mock('../engine/github-app.js', () => ({
  getInstallationToken: vi.fn(async () => 'ghs_secret'),
  webBase: () => 'https://github.com',
}));

let mod;
beforeEach(async () => {
  delete process.env.AEGIS_REPOS_BASE;
  delete process.env.AEGIS_WORKTREES;
  store.cfg = null;
  vi.resetModules();
  mod = await import('../engine/tenant-repo.js');
});

describe('tenant-repo', () => {
  it('legacy mode: shared root, HEAD base, no-op ensure', async () => {
    process.env.AEGIS_REPO_ROOT = '/srv/repo';
    expect(mod.multiRepoMode()).toBe(false);
    expect(mod.repoRootFor('acme')).toBe(path.resolve('/srv/repo'));
    expect(await mod.ensureTenantRepo('acme')).toEqual({ root: path.resolve('/srv/repo'), baseRef: 'HEAD' });
    expect(mod.scanRootFor('acme')).toBeUndefined();
  });

  it('multi mode: per-tenant roots, isolated worktree base', () => {
    process.env.AEGIS_REPOS_BASE = '/data/repos';
    expect(mod.repoRootFor('acme')).toBe(path.resolve('/data/repos/acme/repo'));
    expect(mod.repoRootFor('beta')).not.toBe(mod.repoRootFor('acme'));
    expect(mod.worktreesBase()).toBe(path.resolve('/data/repos/.worktrees'));
    expect(() => mod.repoRootFor('../evil')).toThrow(/Invalid tenantId/);
  });

  it('multi mode: fails closed when tenant has no connected repo', async () => {
    process.env.AEGIS_REPOS_BASE = '/data/repos';
    await expect(mod.ensureTenantRepo('acme')).rejects.toMatchObject({ code: 'TENANT_REPO_NOT_CONNECTED' });
    store.cfg = { status: 'pending', owner: 'o', repo: 'r' };
    await expect(mod.getRepoAccess('acme')).rejects.toMatchObject({ code: 'TENANT_REPO_NOT_CONNECTED' });
  });

  it('auth env carries token via GIT_CONFIG_*, never argv/URL', async () => {
    process.env.AEGIS_REPOS_BASE = '/data/repos';
    store.cfg = { status: 'connected', owner: 'o', repo: 'r', installationId: '1', defaultBranch: 'main' };
    const { env } = await mod.getRepoAccess('acme');
    expect(env.GIT_CONFIG_VALUE_0).toContain(Buffer.from('x-access-token:ghs_secret').toString('base64'));
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('gitlab: authenticates as oauth2 against the GitLab host, allows subgroups', async () => {
    process.env.AEGIS_REPOS_BASE = '/data/repos';
    store.cfg = { provider: 'gitlab', status: 'connected', owner: 'grp/sub', repo: 'app', defaultBranch: 'main' };
    const { env, fullName, provider } = await mod.getRepoAccess('acme');
    expect(fullName).toBe('grp/sub/app');
    expect(provider.name).toBe('gitlab');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.com/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toContain(Buffer.from('oauth2:oauth_secret').toString('base64'));
  });

  it('bitbucket: authenticates as x-token-auth against bitbucket.org', async () => {
    process.env.AEGIS_REPOS_BASE = '/data/repos';
    store.cfg = { provider: 'bitbucket', status: 'connected', owner: 'ws', repo: 'app', defaultBranch: 'main' };
    const { env } = await mod.getRepoAccess('acme');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://bitbucket.org/.extraheader');
    expect(env.GIT_CONFIG_VALUE_0).toContain(Buffer.from('x-token-auth:oauth_secret').toString('base64'));
  });

  it('subgroup owners are gitlab-only', () => {
    expect(() => mod.assertRepoName('grp/sub', 'app', 'gitlab')).not.toThrow();
    expect(() => mod.assertRepoName('grp/sub', 'app', 'github')).toThrow();
    expect(() => mod.assertRepoName('grp/sub', 'app', 'bitbucket')).toThrow();
  });

  it('rejects hostile repo identifiers', () => {
    expect(() => mod.assertRepoName('o', '..')).toThrow();
    expect(() => mod.assertRepoName('o', 'a b')).toThrow();
    expect(() => mod.assertRepoName('o', 'ok-repo.js')).not.toThrow();
  });
});
