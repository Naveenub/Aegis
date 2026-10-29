/**
 * tests/compliance-wiring.test.js
 *
 * The retention engine, DPA, subprocessor list and legal pages were built but
 * not reachable: server.js had no retention/deletion routes, only /privacy and
 * /terms were served, tenant-registry lacked the accessors retention-policy.js
 * imports, and package.json lacked the npm scripts the cron manifests run.
 * server.js has no exported app, so wiring is pinned at the source level.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const src = read('server.js');
const lineOf = (needle) => src.split('\n').find((l) => l.includes(needle)) ?? '';

describe('compliance routes in server.js', () => {
  it.each([
    ["app.get('/tenants/:id/retention'"],
    ["app.put('/tenants/:id/retention'"],
    ["app.post('/tenants/:id/data-deletion'"],
  ])('%s requires an API key and tenant.admin', (needle) => {
    const l = lineOf(needle);
    expect(l).not.toBe('');
    expect(l).toContain('requireApiKey');
    expect(l).toContain("requirePermission('tenant.admin')");
  });

  it('checks tenant ownership on every retention/deletion route', () => {
    for (const n of ["app.get('/tenants/:id/retention'", "app.put('/tenants/:id/retention'", "app.post('/tenants/:id/data-deletion'"]) {
      const body = src.slice(src.indexOf(n)).split('\n').slice(0, 3).join('\n');
      expect(body).toContain('assertTenantAccess');
    }
  });

  it('data-deletion requires the tenant id as confirmation and is audited', () => {
    expect(src).toContain('req.body?.confirm !== req.params.id');
    expect(src).toContain("action: 'data.deleted'");
    expect(src).toContain("action: 'retention.updated'");
  });

  it.each(['/privacy', '/dpa', '/security', '/subprocessors', '/subprocessors.json'])('serves %s', (p) => {
    expect(lineOf(`app.get('${p}'`)).not.toBe('');
  });

  it('starts the in-process retention safety net at boot', () => {
    expect(src).toContain('startRetentionScheduler()');
  });

  it('package.json has the scripts the cron manifests and launch gate call', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['retention:sweep']).toBe('node scripts/retention-sweep.js');
    expect(scripts['compliance:check']).toBe('node scripts/compliance-check.js');
  });
});

describe('subprocessor page rendering', async () => {
  const { renderSubprocessorsPage, publicSubprocessors } = await import('../engine/compliance-pages.js');
  const subs = JSON.parse(read('compliance/subprocessors.json'));
  const html = renderSubprocessorsPage(read('landing/subprocessors.html'), subs);

  it('fills every placeholder except the contact email', () => {
    expect(html.match(/\{\{[A-Z_]+\}\}/g)?.filter((m) => m !== '{{CONTACT_EMAIL}}') ?? []).toEqual([]);
  });

  it('lists Anthropic and OpenAI', () => {
    expect(html).toContain('Anthropic, PBC');
    expect(html).toContain('OpenAI, L.L.C.');
  });

  it('escapes values', () => {
    const out = renderSubprocessorsPage('{{SUBPROCESSOR_ROWS}}{{SUBPROCESSORS_UPDATED}}{{SUBPROCESSORS_NOTICE}}{{CUSTOMER_DIRECTED}}', {
      lastUpdated: '<b>', noticePeriodDays: 30, subprocessors: [{ name: '<script>x</script>', use: 'always' }], customerDirectedIntegrations: { items: ['A&B'] },
    });
    expect(out).not.toContain('<script>');
    expect(out).toContain('A&amp;B');
  });

  it('public JSON omits operator-only fields', () => {
    const pub = publicSubprocessors(subs);
    expect(pub.subprocessors.length).toBe(subs.subprocessors.length);
    for (const s of pub.subprocessors) { expect(s).not.toHaveProperty('operatorConfirm'); expect(s).not.toHaveProperty('confirmed'); }
  });
});

describe('tenant-registry retention accessors', () => {
  it('round-trips overrides and resets with null', async () => {
    const store = new Map();
    vi.resetModules();
    vi.doMock('ioredis', () => ({
      default: vi.fn(() => ({
        on: () => {},
        hget: async (_k, f) => store.get(f) ?? null,
        hset: async (_k, o) => { for (const [a, b] of Object.entries(o)) store.set(a, b); return 1; },
      })),
    }));
    const { getRetentionConfig, setRetentionConfig } = await import('../engine/tenant-registry.js');
    expect(await getRetentionConfig('acme')).toEqual({ jobsDays: null, workflowsDays: null, memoryDays: null, zeroRetention: false });
    await setRetentionConfig('acme', { jobsDays: 30, zeroRetention: true });
    await setRetentionConfig('acme', { memoryDays: 7 });
    expect(await getRetentionConfig('acme')).toEqual({ jobsDays: 30, workflowsDays: null, memoryDays: 7, zeroRetention: true });
    await setRetentionConfig('acme', { jobsDays: null });
    expect((await getRetentionConfig('acme')).jobsDays).toBeNull();
    vi.doUnmock('ioredis');
  });
});
