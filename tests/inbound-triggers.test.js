import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../engine/orchestrator.js', () => ({ runSystem: vi.fn(async () => 'wf-1') }));
vi.mock('../engine/tenant-registry.js', () => ({ getStatus: vi.fn(async () => 'active') }));
vi.mock('../engine/repo-store.js', () => ({
  getRepoConfig: vi.fn(async () => ({ status: 'connected', owner: 'acme', repo: 'app', installationId: 7 })),
}));
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent: vi.fn(async () => {}) }));
vi.mock('../engine/trigger-origin.js', () => ({ sendToOrigin: vi.fn(async () => {}) }));
const seen = new Set();
vi.mock('../engine/trigger-store.js', () => ({
  claimOnce: vi.fn(async (k) => (seen.has(k) ? false : (seen.add(k), true))),
  saveOrigin: vi.fn(async () => {}),
}));

const t = await import('../engine/inbound-triggers.js');
const { runSystem } = await import('../engine/orchestrator.js');
const { getStatus } = await import('../engine/tenant-registry.js');

beforeEach(() => { seen.clear(); vi.clearAllMocks(); getStatus.mockResolvedValue('active'); });
const tick = () => new Promise(r => setTimeout(r, 0));

describe('verifySlackSignature', () => {
  const secret = 's3cret', body = Buffer.from('team_id=T1&text=hi');
  const sign = (ts) => 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:`).update(body).digest('hex');
  const now = 1_700_000_000_000, ts = String(now / 1000);
  it('accepts valid', () => expect(t.verifySlackSignature(body, sign(ts), ts, secret, now)).toBe(true));
  it('rejects bad sig', () => expect(t.verifySlackSignature(body, 'v0=00', ts, secret, now)).toBe(false));
  it('rejects stale', () => expect(t.verifySlackSignature(body, sign(ts), ts, secret, now + 400_000)).toBe(false));
  it('fails closed without secret', () => expect(t.verifySlackSignature(body, sign(ts), ts, '', now)).toBe(false));
});

describe('verifyJiraRequest', () => {
  const body = Buffer.from('{"a":1}'), secret = 'k';
  it('hmac', () => expect(t.verifyJiraRequest(body, { 'x-hub-signature': 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex') }, secret)).toBe(true));
  it('token', () => expect(t.verifyJiraRequest(body, { 'x-aegis-token': 'k' }, secret)).toBe(true));
  it('wrong', () => expect(t.verifyJiraRequest(body, { 'x-aegis-token': 'x' }, secret)).toBe(false));
  it('no secret', () => expect(t.verifyJiraRequest(body, { 'x-aegis-token': 'k' }, null)).toBe(false));
});

describe('parseIssueLabeled', () => {
  const p = (o = {}) => ({ action: 'labeled', label: { name: 'Aegis' }, repository: { full_name: 'acme/app' }, issue: { number: 3, title: 'T', body: 'B' }, sender: { login: 'u' }, ...o });
  it('matches case-insensitively', () => expect(t.parseIssueLabeled(p(), 'aegis')).toMatchObject({ owner: 'acme', repo: 'app', number: 3 }));
  it('ignores other labels', () => expect(t.parseIssueLabeled(p({ label: { name: 'bug' } }), 'aegis')).toBeNull());
  it('ignores PRs', () => expect(t.parseIssueLabeled(p({ issue: { number: 1, pull_request: {} } }), 'aegis')).toBeNull());
});

describe('parseJiraEvent', () => {
  it('created with label', () => expect(t.parseJiraEvent({ webhookEvent: 'jira:issue_created', issue: { key: 'APP-1', fields: { labels: ['aegis'], summary: 's' } } }, 'aegis')?.key).toBe('APP-1'));
  it('updated: label newly added', () => expect(t.parseJiraEvent({ webhookEvent: 'jira:issue_updated', issue: { key: 'APP-1', fields: {} }, changelog: { items: [{ field: 'labels', fromString: 'x', toString: 'x aegis' }] } }, 'aegis')).not.toBeNull());
  it('updated: label already present', () => expect(t.parseJiraEvent({ webhookEvent: 'jira:issue_updated', issue: { key: 'APP-1', fields: {} }, changelog: { items: [{ field: 'labels', fromString: 'aegis', toString: 'aegis y' }] } }, 'aegis')).toBeNull());
  it('project filter', () => expect(t.parseJiraEvent({ webhookEvent: 'jira:issue_created', issue: { key: 'OPS-1', fields: { labels: ['aegis'] } } }, 'aegis', ['APP'])).toBeNull());
  it('automation shape + ADF', () => {
    const r = t.parseJiraEvent({ issueKey: 'APP-9', summary: 's', labels: ['aegis'], description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] } }, 'aegis');
    expect(r.description).toContain('hello');
  });
});

describe('handleIssueLabeled', () => {
  const payload = { action: 'labeled', label: { name: 'aegis' }, repository: { full_name: 'acme/app' }, issue: { number: 3, title: 'Crash', body: 'steps' }, sender: { login: 'u' } };
  it('starts a workflow with tenant + fenced task', async () => {
    const r = await t.handleIssueLabeled('acme', payload, 'd1', 'aegis');
    await tick();
    expect(r.accepted).toBe(true);
    const [task, opts] = runSystem.mock.calls[0];
    expect(opts).toEqual({ tenantId: 'acme' });
    expect(task).toContain('untrusted');
    expect(task).toContain('Crash');
  });
  it('dedupes redelivery', async () => {
    await t.handleIssueLabeled('acme', payload, 'd1', 'aegis');
    const r = await t.handleIssueLabeled('acme', payload, 'd1', 'aegis');
    expect(r.accepted).toBe(false);
  });
  it('rejects a repo that is not the tenant repo', async () => {
    const r = await t.handleIssueLabeled('acme', { ...payload, repository: { full_name: 'evil/x' } }, 'd2', 'aegis');
    expect(r.accepted).toBe(false);
    expect(runSystem).not.toHaveBeenCalled();
  });
  it('blocks suspended tenants', async () => {
    getStatus.mockResolvedValue('suspended');
    const r = await t.handleIssueLabeled('acme', payload, 'd3', 'aegis');
    expect(r.accepted).toBe(false);
    expect(runSystem).not.toHaveBeenCalled();
  });
});
