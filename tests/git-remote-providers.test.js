import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const access = { value: null };
const push = vi.fn(async () => {});
vi.mock('../engine/tenant-repo.js', () => ({
  multiRepoMode: () => true,
  getRepoAccess: vi.fn(async () => access.value),
  pushFromTenantRepo: (...a) => push(...a),
}));

const res = (body, status = 200) => ({
  ok: status < 400, status,
  json: async () => body, text: async () => JSON.stringify(body),
  clone() { return res(body, status); },
});

let pushAndOpenPR;
beforeEach(async () => {
  delete process.env.AEGIS_GIT_PUSH_BRANCH;
  push.mockClear();
  vi.resetModules();
  ({ pushAndOpenPR } = await import('../engine/git-remote.js'));
});
afterEach(() => { vi.unstubAllGlobals(); });

const gl = () => ({
  provider: { name: 'gitlab' }, token: 'glo_tok', fullName: 'grp/sub/app',
  cfg: { defaultBranch: 'main', targetBranch: 'develop' },
});

describe('per-tenant GitLab MR', () => {
  it('pushes the tenant branch and opens an MR with the OAuth token as Bearer', async () => {
    access.value = gl();
    vi.stubGlobal('fetch', vi.fn(async () => res({ web_url: 'https://gl/mr/1', iid: 1 }, 201)));
    const out = await pushAndOpenPR('wf1', 'acme', { merged: true });

    expect(push).toHaveBeenCalledWith('acme', 'aegis-tenant/acme');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://gitlab.com/api/v4/projects/grp%2Fsub%2Fapp/merge_requests');
    expect(init.headers.Authorization).toBe('Bearer glo_tok');
    expect(init.headers['PRIVATE-TOKEN']).toBeUndefined();
    expect(JSON.parse(init.body)).toMatchObject({ source_branch: 'aegis-tenant/acme', target_branch: 'develop' });
    expect(out).toEqual({ pushed: true, pr: { url: 'https://gl/mr/1', number: 1 } });
  });

  it('returns the already-open MR when GitLab answers 409', async () => {
    access.value = gl();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res({ message: 'Another open merge request already exists' }, 409))
      .mockResolvedValueOnce(res([{ web_url: 'https://gl/mr/9', iid: 9 }])));
    const out = await pushAndOpenPR('wf2', 'acme', { merged: true });
    expect(out.pr).toEqual({ url: 'https://gl/mr/9', number: 9 });
    expect(fetch.mock.calls[1][0]).toContain('state=opened');
  });
});

describe('per-tenant Bitbucket PR', () => {
  const bb = () => ({
    provider: { name: 'bitbucket' }, token: 'bb_tok', fullName: 'ws/app',
    cfg: { defaultBranch: 'main', targetBranch: 'main' },
  });

  it('opens a PR with Bearer auth', async () => {
    access.value = bb();
    vi.stubGlobal('fetch', vi.fn(async () => res({ id: 4, links: { html: { href: 'https://bb/pr/4' } } }, 201)));
    const out = await pushAndOpenPR('wf1', 'acme', { merged: true });
    expect(fetch.mock.calls[0][0]).toBe('https://api.bitbucket.org/2.0/repositories/ws/app/pullrequests');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer bb_tok');
    expect(out.pr).toEqual({ url: 'https://bb/pr/4', number: 4 });
  });

  it('returns the already-open PR on a duplicate', async () => {
    access.value = bb();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res({ error: { message: 'There is already an open pull request for this branch' } }, 400))
      .mockResolvedValueOnce(res({ values: [{ id: 8, links: { html: { href: 'https://bb/pr/8' } } }] })));
    const out = await pushAndOpenPR('wf2', 'acme', { merged: true });
    expect(out.pr).toEqual({ url: 'https://bb/pr/8', number: 8 });
  });
});

describe('per-tenant GitHub (unchanged)', () => {
  it('still uses the GitHub PR endpoint with the installation token', async () => {
    access.value = { provider: { name: 'github' }, token: 'ghs_x', fullName: 'o/r', cfg: { defaultBranch: 'main' } };
    vi.stubGlobal('fetch', vi.fn(async () => res({ html_url: 'https://gh/pr/2', number: 2 }, 201)));
    const out = await pushAndOpenPR('wf', 'acme', { merged: true });
    expect(fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls');
    expect(out.pr.number).toBe(2);
  });
});
