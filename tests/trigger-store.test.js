import { describe, it, expect, vi } from 'vitest';

vi.mock('ioredis', () => {
  const kv = new Map(), hs = new Map();
  const H = (k) => (hs.has(k) ? hs.get(k) : hs.set(k, new Map()).get(k));
  const c = {
    on() {},
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v, ...a) { if (a.includes('NX') && kv.has(k)) return null; kv.set(k, String(v)); return 'OK'; },
    async getdel(k) { const v = kv.get(k) ?? null; kv.delete(k); return v; },
    async del(...ks) { for (const k of ks) { kv.delete(k); hs.delete(k); } return 1; },
    async hget(k, f) { return H(k).get(f) ?? null; },
    async hset(k, o) { for (const [f, v] of Object.entries(o)) H(k).set(f, String(v)); return 1; },
    async hdel(k, f) { H(k).delete(f); return 1; },
    async hgetall(k) { return Object.fromEntries(H(k)); },
  };
  return { default: function () { return c; } };
});
vi.mock('../engine/token-vault.js', () => ({
  seal: (x, aad) => `sealed:${aad}:${x}`,
  open: (x, aad) => { const p = `sealed:${aad}:`; if (!x.startsWith(p)) throw new Error('aad mismatch'); return x.slice(p.length); },
}));

const s = await import('../engine/trigger-store.js');

describe('trigger-store', () => {
  it('link codes are single-use and bind the team', async () => {
    const code = await s.createSlackLinkCode('acme');
    expect(await s.consumeSlackLinkCode(code, 'T1')).toBe('acme');
    expect(await s.consumeSlackLinkCode(code, 'T1')).toBeNull();
    expect(await s.tenantForSlackTeam('T1')).toBe('acme');
  });
  it('a workspace cannot be claimed by a second tenant', async () => {
    const code = await s.createSlackLinkCode('other');
    await expect(s.consumeSlackLinkCode(code, 'T1')).rejects.toMatchObject({ code: 'TEAM_TAKEN' });
    expect(await s.tenantForSlackTeam('T1')).toBe('acme');
  });
  it('unlink frees the team and drops the bot token', async () => {
    await s.saveSlackBotToken('acme', 'xoxb-1');
    await s.unlinkSlack('acme');
    expect(await s.tenantForSlackTeam('T1')).toBeNull();
    expect(await s.loadSlackBotToken('acme')).toBeNull();
  });
  it('claimOnce is true once', async () => {
    expect(await s.claimOnce('k1')).toBe(true);
    expect(await s.claimOnce('k1')).toBe(false);
  });
  it('Jira creds round-trip sealed and bound to the tenant', async () => {
    await s.saveJiraCreds('acme', { baseUrl: 'https://a.atlassian.net', email: 'a@b.co', apiToken: 'tok12345' });
    expect(await s.loadJiraCreds('acme')).toMatchObject({ email: 'a@b.co' });
    expect((await s.getTriggerConfig('acme')).jiraWriteBack).toBe(true);
  });
  it('config validation', async () => {
    await expect(s.setTriggerConfig('acme', { githubLabel: '<x>' })).rejects.toThrow();
    await expect(s.setTriggerConfig('acme', { jiraProjects: ['bad key'] })).rejects.toThrow();
    expect((await s.setTriggerConfig('acme', { githubLabel: 'ai-fix', jiraProjects: ['APP'] })).githubLabel).toBe('ai-fix');
  });
  it('origin problems are surfaced then cleared', async () => {
    await s.noteOriginProblem('acme', 'github-comment', 'x');
    expect((await s.getTriggerConfig('acme')).lastOriginProblem.kind).toBe('github-comment');
    await s.clearOriginProblem('acme', 'github-comment');
    expect((await s.getTriggerConfig('acme')).lastOriginProblem).toBeNull();
  });
});
