import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

const store = { cfg: null };
vi.mock('../engine/repo-store.js', () => ({
  getRepoConfig: vi.fn(async () => store.cfg),
  patchRepo: vi.fn(async () => {}),
  withRepoLock: vi.fn(async (_t, fn) => fn()),
}));
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

  it('rejects hostile repo identifiers', () => {
    expect(() => mod.assertRepoName('o', '..')).toThrow();
    expect(() => mod.assertRepoName('o', 'a b')).toThrow();
    expect(() => mod.assertRepoName('o', 'ok-repo.js')).not.toThrow();
  });
});
