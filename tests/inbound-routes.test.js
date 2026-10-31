import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';

process.env.AEGIS_SLACK_SIGNING_SECRET = 'slack-secret';
process.env.AEGIS_OAUTH_STATE_SECRET = 'x'.repeat(40);
process.env.AEGIS_SLACK_CLIENT_ID = 'cid';
process.env.AEGIS_SLACK_CLIENT_SECRET = 'csec';
process.env.AEGIS_PUBLIC_URL = 'https://aegis.test';
process.env.AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET = 'mkt-secret';
process.env.AEGIS_GITHUB_MARKETPLACE_PLANS = '{"Team":"team"}';

const S = vi.hoisted(() => ({ kv: new Map(), teams: new Map(), links: new Map(), jsec: new Map(), bots: new Map(),
  jcred: new Map(), cfg: new Map(), origins: new Map(), problems: [], nonces: new Set(), seen: new Set() }));

vi.mock('../engine/orchestrator.js', () => ({ runSystem: vi.fn(async () => 'wf-1') }));
vi.mock('../engine/tenant-registry.js', () => ({
  getStatus: vi.fn(async () => 'active'), setTier: vi.fn(async () => {}), setStatus: vi.fn(async () => {}), markFirstPaid: vi.fn(async () => {}),
}));
vi.mock('../engine/tenant-quota.js', () => ({ setQuota: vi.fn(async () => {}) }));
vi.mock('../engine/repo-store.js', () => ({
  getRepoConfig: vi.fn(async () => ({ status: 'connected', owner: 'acme', repo: 'app', installationId: 7 })),
  tenantForInstallation: vi.fn(async (id) => (String(id) === '7' ? 'acme' : null)),
  consumeStateNonce: vi.fn(async (n) => (S.nonces.has(n) ? false : (S.nonces.add(n), true))),
}));
vi.mock('../engine/audit-log.js', () => ({ recordAuditEvent: vi.fn(async () => {}) }));
vi.mock('../engine/github-app.js', () => ({ appJwt: () => 'jwt' }));
vi.mock('../engine/token-vault.js', () => ({ tokenVaultConfigured: () => true, seal: (x) => x, open: (x) => x }));
vi.mock('../middleware/auth.js', () => ({
  requireApiKey: (_q, _s, n) => n(), requirePermission: () => (_q, _s, n) => n(),
  assertTenantAccess: () => true, auditActor: () => ({ actorId: 't' }),
}));
vi.mock('../engine/trigger-store.js', () => ({
  getTriggerConfig: vi.fn(async (t) => ({ githubLabel: 'aegis', jiraLabel: 'aegis', jiraProjects: [], slackAllowedUsers: S.cfg.get(`${t}:allowed`) ?? [], slackTeamId: null })),
  setTriggerConfig: vi.fn(), unlinkSlack: vi.fn(), deleteJiraSecret: vi.fn(), rotateJiraSecret: vi.fn(),
  createSlackLinkCode: vi.fn(async (t) => { S.links.set('ABCDEF0123', t); return 'ABCDEF0123'; }),
  consumeSlackLinkCode: vi.fn(async (c, team) => { const t = S.links.get(c); if (!t) return null; S.links.delete(c); S.teams.set(team, t); return t; }),
  bindSlackTeam: vi.fn(async (t, team) => { S.teams.set(team, t); }),
  tenantForSlackTeam: vi.fn(async (team) => S.teams.get(team) ?? null),
  getJiraSecret: vi.fn(async (t) => S.jsec.get(t) ?? null),
  claimOnce: vi.fn(async (k) => (S.seen.has(k) ? false : (S.seen.add(k), true))),
  saveOrigin: vi.fn(async (w, o) => { S.origins.set(w, o); }), loadOrigin: vi.fn(async (w) => S.origins.get(w) ?? null),
  saveSlackBotToken: vi.fn(async (t, tok) => { S.bots.set(t, tok); }), loadSlackBotToken: vi.fn(async (t) => S.bots.get(t) ?? null),
  saveJiraCreds: vi.fn(async (t, c) => { S.jcred.set(t, c); }), loadJiraCreds: vi.fn(async (t) => S.jcred.get(t) ?? null), deleteJiraCreds: vi.fn(),
  noteOriginProblem: vi.fn(async (t, k) => { S.problems.push([t, k]); }), clearOriginProblem: vi.fn(async () => {}),
}));

const { triggerWebhookRouter, triggerRouter } = await import('../engine/trigger-routes.js');
const { marketplaceRouter } = await import('../engine/marketplace.js');
const { assertJiraBaseUrl, sendToOrigin } = await import('../engine/trigger-origin.js');
const { runSystem } = await import('../engine/orchestrator.js');
const reg = await import('../engine/tenant-registry.js');
const { signOAuthState } = await import('../engine/oauth-state.js');

const realFetch = globalThis.fetch;
const outbound = [];
let outboundHandler = () => ({ ok: true, status: 200, json: async () => ({}) });
vi.stubGlobal('fetch', (url, init) => {
  if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
  outbound.push({ url: String(url), init });
  return Promise.resolve(outboundHandler(String(url), init));
});

let server, base;
beforeAll(async () => {
  const app = express();
  app.use('/webhooks', triggerWebhookRouter);
  app.use('/webhooks', marketplaceRouter);
  app.use(express.json());
  app.use(triggerRouter);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  Object.values(S).forEach(v => v.clear?.()); S.problems.length = 0; outbound.length = 0;
  vi.clearAllMocks(); outboundHandler = () => ({ ok: true, status: 200, json: async () => ({}) });
});
const tick = () => new Promise(r => setTimeout(r, 10));

const slackPost = (form, { badSig = false } = {}) => {
  const body = new URLSearchParams(form).toString();
  const ts = String(Math.floor(Date.now() / 1000));
  let sig = 'v0=' + crypto.createHmac('sha256', 'slack-secret').update(`v0:${ts}:${body}`).digest('hex');
  if (badSig) sig = 'v0=deadbeef';
  return realFetch(`${base}/webhooks/slack/command`, { method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts } });
};

describe('Slack /aegis', () => {
  it('rejects bad signatures', async () => expect((await slackPost({ text: 'x' }, { badSig: true })).status).toBe(401));

  it('link code → linked → task runs under that tenant', async () => {
    S.links.set('ABCDEF0123', 'acme');
    let j = await (await slackPost({ team_id: 'T1', user_id: 'U1', text: 'link ABCDEF0123', trigger_id: 'a' })).json();
    expect(j.text).toContain('linked');
    j = await (await slackPost({ team_id: 'T1', user_id: 'U1', channel_id: 'C1', text: 'fix the login bug', trigger_id: 'b', response_url: 'https://hooks.slack.com/commands/x' })).json();
    expect(j.text).toContain('received');
    await tick();
    expect(runSystem.mock.calls[0][1]).toEqual({ tenantId: 'acme' });
    expect(S.origins.get('wf-1')).toMatchObject({ type: 'slack', tenantId: 'acme', channelId: 'C1' });
  });

  it('unlinked workspace is told to link', async () => {
    const j = await (await slackPost({ team_id: 'T9', user_id: 'U1', text: 'do it', trigger_id: 'c' })).json();
    expect(j.text).toContain('not linked');
    expect(runSystem).not.toHaveBeenCalled();
  });

  it('allowlist blocks other users', async () => {
    S.teams.set('T1', 'acme'); S.cfg.set('acme:allowed', ['UOK']);
    const j = await (await slackPost({ team_id: 'T1', user_id: 'UBAD', text: 'do it', trigger_id: 'd' })).json();
    expect(j.text).toContain('not allowed');
    expect(runSystem).not.toHaveBeenCalled();
  });
});

describe('Slack OAuth callback', () => {
  const cb = (state) => realFetch(`${base}/slack/oauth/callback?code=c1&state=${encodeURIComponent(state)}`);
  it('binds the Slack-verified team and stores the bot token; state is single-use', async () => {
    outboundHandler = () => ({ ok: true, status: 200, json: async () => ({ ok: true, access_token: 'xoxb-1', team: { id: 'T7' } }) });
    const state = signOAuthState('acme', 'slack');
    const r = await cb(state);
    expect(r.status).toBe(200);
    expect(S.teams.get('T7')).toBe('acme');
    expect(S.bots.get('acme')).toBe('xoxb-1');
    expect((await cb(state)).status).toBe(400);
  });
  it('rejects a state minted for another provider', async () => {
    expect((await cb(signOAuthState('acme', 'gitlab'))).status).toBe(400);
  });
});

describe('Slack replies', () => {
  it('prefers the bot token (no 30-min limit), falls back to response_url', async () => {
    S.bots.set('acme', 'xoxb-1');
    await sendToOrigin({ type: 'slack', tenantId: 'acme', channelId: 'C1', responseUrl: 'https://hooks.slack.com/commands/x', expiresAt: 0 }, 'done');
    expect(outbound[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(JSON.parse(outbound[0].init.body)).toMatchObject({ channel: 'C1' });

    outbound.length = 0; S.bots.clear();
    await sendToOrigin({ type: 'slack', tenantId: 'acme', channelId: 'C1', responseUrl: 'https://hooks.slack.com/commands/x', expiresAt: Date.now() + 60_000 }, 'done');
    expect(outbound[0].url).toBe('https://hooks.slack.com/commands/x');
  });
  it('never posts to a non-Slack response_url', async () => {
    await sendToOrigin({ type: 'slack', tenantId: 'acme', responseUrl: 'https://evil.test/x', expiresAt: Date.now() + 60_000 }, 'x');
    expect(outbound).toHaveLength(0);
  });
});

describe('Jira trigger + write-back', () => {
  const created = { webhookEvent: 'jira:issue_created', issue: { key: 'APP-1', fields: { labels: ['aegis'], summary: 'Crash', description: 'steps' } } };
  const post = (body, headers = {}) => realFetch(`${base}/webhooks/jira/acme`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

  it('401 without secret / bad token', async () => {
    expect((await post(created)).status).toBe(401);
    S.jsec.set('acme', 'tok');
    expect((await post(created, { 'x-aegis-token': 'nope' })).status).toBe(401);
  });
  it('202, runs under tenant, records jira origin, dedupes the ticket', async () => {
    S.jsec.set('acme', 'tok');
    expect((await post(created, { 'x-aegis-token': 'tok' })).status).toBe(202);
    await tick();
    expect(runSystem.mock.calls[0][1]).toEqual({ tenantId: 'acme' });
    expect(S.origins.get('wf-1')).toEqual({ type: 'jira', tenantId: 'acme', key: 'APP-1' });
    expect((await (await post(created, { 'x-aegis-token': 'tok' })).json()).reason).toContain('already running');
  });
  it('comments on the ticket with the tenant credentials', async () => {
    S.jcred.set('acme', { baseUrl: 'https://acme.atlassian.net', email: 'a@b.co', apiToken: 'tok12345' });
    await sendToOrigin({ type: 'jira', tenantId: 'acme', key: 'APP-1' }, 'finished');
    expect(outbound[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/APP-1/comment');
    expect(outbound[0].init.headers.Authorization).toBe('Basic ' + Buffer.from('a@b.co:tok12345').toString('base64'));
  });
  it('SSRF guard on baseUrl', () => {
    expect(assertJiraBaseUrl('https://acme.atlassian.net/foo')).toBe('https://acme.atlassian.net');
    for (const bad of ['http://acme.atlassian.net', 'https://evil.com', 'https://acme.atlassian.net.evil.com', 'https://u:p@acme.atlassian.net', 'https://acme.atlassian.net:8443', 'https://169.254.169.254']) {
      expect(() => assertJiraBaseUrl(bad), bad).toThrow();
    }
  });
});

describe('GitHub comment failures are surfaced', () => {
  it('records a problem when Issues: write is missing', async () => {
    outboundHandler = (url) => (url.includes('access_tokens') ? { ok: false, status: 422, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({}) });
    await sendToOrigin({ type: 'github', tenantId: 'acme', installationId: 7, owner: 'acme', repo: 'app', number: 3 }, 'hi');
    expect(S.problems).toEqual([['acme', 'github-comment']]);
  });
});

describe('Marketplace purchases', () => {
  const send = (payload, { sig } = {}) => {
    const body = JSON.stringify(payload);
    const s = sig ?? 'sha256=' + crypto.createHmac('sha256', 'mkt-secret').update(body).digest('hex');
    return realFetch(`${base}/webhooks/github-marketplace`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-github-event': 'marketplace_purchase', 'x-hub-signature-256': s, 'x-github-delivery': crypto.randomUUID() } });
  };
  const ev = (action, plan = 'Team', login = 'acme') => ({ action, marketplace_purchase: { account: { type: 'Organization', login }, plan: { name: plan } } });
  const installLookup = (code, id) => { outboundHandler = () => ({ ok: code === 200, status: code, json: async () => ({ id }) }); };

  it('401 on bad signature', async () => expect((await send(ev('purchased'), { sig: 'sha256=00' })).status).toBe(401));
  it('purchased → mapped tier + active', async () => {
    installLookup(200, 7);
    const j = await (await send(ev('purchased'))).json();
    expect(j).toEqual({ applied: true, tier: 'team' });
    expect(reg.setTier).toHaveBeenCalledWith('acme', 'team');
    expect(reg.setStatus).toHaveBeenCalledWith('acme', 'active');
    expect(outbound[0].url).toContain('/orgs/acme/installation');
  });
  it('cancelled → free tier', async () => {
    installLookup(200, 7);
    expect((await (await send(ev('cancelled'))).json()).tier).toBe('free');
  });
  it('unmapped plan → no change', async () => {
    installLookup(200, 7);
    expect((await (await send(ev('purchased', 'Mystery'))).json()).reason).toBe('unmapped plan');
    expect(reg.setTier).not.toHaveBeenCalled();
  });
  it('account without a linked tenant → no change', async () => {
    installLookup(404);
    expect((await (await send(ev('purchased', 'Team', 'nobody'))).json()).reason).toBe('no linked tenant');
    expect(reg.setTier).not.toHaveBeenCalled();
  });
});
