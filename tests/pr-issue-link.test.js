import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const origin = { value: null };
vi.mock('../engine/trigger-store.js', () => ({ loadOrigin: vi.fn(async () => origin.value) }));
vi.mock('../engine/tenant-repo.js', () => ({
  multiRepoMode: () => true,
  getRepoAccess: vi.fn(async () => ({ provider: { name: 'github' }, token: 't', fullName: 'acme/app', cfg: { defaultBranch: 'main' } })),
  pushFromTenantRepo: vi.fn(async () => {}),
}));

let pushAndOpenPR;
beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 201, json: async () => ({ html_url: 'https://gh/pr/1', number: 1 }),
    text: async () => '', clone() { return this; },
  })));
  vi.resetModules();
  ({ pushAndOpenPR } = await import('../engine/git-remote.js'));
});
afterEach(() => vi.unstubAllGlobals());

const body = () => JSON.parse(fetch.mock.calls[0][1].body).body;

describe('PR links its trigger without the Issues permission', () => {
  it('GitHub issue in the same repo → Closes #N', async () => {
    origin.value = { type: 'github', owner: 'acme', repo: 'app', number: 12 };
    await pushAndOpenPR('wf1', 'acme', { merged: true });
    expect(body()).toContain('Closes #12');
  });
  it('issue from another repo is not linked', async () => {
    origin.value = { type: 'github', owner: 'evil', repo: 'x', number: 12 };
    await pushAndOpenPR('wf1', 'acme', { merged: true });
    expect(body()).not.toContain('Closes');
  });
  it('Jira ticket → key in body', async () => {
    origin.value = { type: 'jira', tenantId: 'acme', key: 'APP-7' };
    await pushAndOpenPR('wf1', 'acme', { merged: true });
    expect(body()).toContain('Jira: APP-7');
  });
  it('no origin → unchanged body', async () => {
    origin.value = null;
    await pushAndOpenPR('wf1', 'acme', { merged: true });
    expect(body()).not.toMatch(/Closes|Jira:/);
  });
});
