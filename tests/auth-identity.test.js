/**
 * tests/auth-identity.test.js — sessions, roles, requirePermission, auditActor, arity
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupByHashMock = vi.fn();
vi.mock('../engine/key-store.js', () => ({ hashKey: (k) => `h:${k}`, lookupByHash: lookupByHashMock }));
const getStatusMock = vi.fn();
vi.mock('../engine/tenant-registry.js', () => ({ getStatus: getStatusMock }));
const resolveSessionMock = vi.fn();
vi.mock('../engine/user-store.js', () => ({ SESSION_PREFIX: 'aegs_', resolveSession: resolveSessionMock }));

let auth;
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  process.env.AEGIS_API_KEY = 'global-secret';
  lookupByHashMock.mockReset().mockResolvedValue(null);
  resolveSessionMock.mockReset().mockResolvedValue(null);
  getStatusMock.mockReset().mockResolvedValue('active');
  auth = await import('../middleware/auth.js');
});

const mkReq = (key, extra = {}) => ({ headers: { 'x-api-key': key }, query: {}, ip: '9.9.9.9', ...extra });
const mkRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const run = async (req, tenant) => { const res = mkRes(), next = vi.fn(); await auth.requireApiKey(req, res, next, tenant); return { res, next }; };

describe('requireApiKey arity', () => {
  it('has length 3 so Express does not mistake it for an error handler', () => {
    expect(auth.requireApiKey.length).toBe(3);
  });
});

describe('credential resolution', () => {
  it('treats env keys and pre-RBAC store keys as admin', async () => {
    const env = mkReq('global-secret');
    expect((await run(env)).next).toHaveBeenCalled();
    expect(env.actor).toMatchObject({ type: 'api-key', id: 'env-key', role: 'admin', tenantId: 'default' });

    lookupByHashMock.mockResolvedValue({ tenantId: 'acme', keyId: 'k1' }); // no role field
    const legacy = mkReq('anything');
    await run(legacy);
    expect(legacy.actor).toMatchObject({ id: 'k1', role: 'admin' });
  });

  it('uses the role stored on a key', async () => {
    lookupByHashMock.mockResolvedValue({ tenantId: 'acme', keyId: 'k2', role: 'viewer' });
    const req = mkReq('x');
    await run(req);
    expect(req.actor.role).toBe('viewer');
    expect(req.resolvedKeyId).toBe('k2');
  });

  it('resolves a session token to a user actor', async () => {
    resolveSessionMock.mockResolvedValue({ userId: 'u_1', tenantId: 'acme', email: 'a@acme.com', role: 'member' });
    const req = mkReq('aegs_tok');
    const { next } = await run(req);
    expect(next).toHaveBeenCalled();
    expect(req.actor).toEqual({ type: 'user', id: 'u_1', email: 'a@acme.com', role: 'member', tenantId: 'acme' });
    expect(req.resolvedKeyId).toBeUndefined();
    expect(lookupByHashMock).not.toHaveBeenCalled();
  });

  it('rejects unknown/disabled sessions and a session for another tenant (403)', async () => {
    expect((await run(mkReq('aegs_dead'))).res.statusCode).toBe(403);
    resolveSessionMock.mockResolvedValue({ userId: 'u_1', tenantId: 'acme', email: 'a@acme.com', role: 'admin' });
    const { res, next } = await run(mkReq('aegs_tok'), 'other');
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('still applies the billing gate to user sessions', async () => {
    resolveSessionMock.mockResolvedValue({ userId: 'u_1', tenantId: 'acme', email: 'a@acme.com', role: 'admin' });
    getStatusMock.mockResolvedValue('suspended');
    expect((await run(mkReq('aegs_tok'))).res.statusCode).toBe(402);
  });

  it('optionalApiKey sets the actor for sessions', async () => {
    resolveSessionMock.mockResolvedValue({ userId: 'u_1', tenantId: 'acme', email: 'a@acme.com', role: 'viewer' });
    const req = mkReq('aegs_tok'), next = vi.fn();
    await auth.optionalApiKey(req, mkRes(), next);
    expect(req.authenticated).toBe(true);
    expect(req.actor.role).toBe('viewer');
  });
});

describe('requirePermission', () => {
  const check = (role, perm) => {
    const res = mkRes(), next = vi.fn();
    auth.requirePermission(perm)({ actor: role && { role } }, res, next);
    return { res, next };
  };

  it('passes when the role holds the permission', () => {
    expect(check('member', 'workflow.run').next).toHaveBeenCalled();
    expect(check('admin', 'key.manage').next).toHaveBeenCalled();
  });

  it('returns 403 naming the required role otherwise', () => {
    const { res, next } = check('viewer', 'workflow.run');
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ permission: 'workflow.run', requiredRole: 'member' });
    expect(check('member', 'audit.read').res.statusCode).toBe(403);
  });

  it('fails closed with no actor and rejects unknown permissions at definition time', () => {
    expect(check(undefined, 'workflow.run').res.statusCode).toBe(403);
    expect(() => auth.requirePermission('typo.perm')).toThrow(/Unknown permission/);
  });
});

describe('auditActor', () => {
  it('names the human behind a session', () => {
    const a = auth.auditActor({ ip: '1.1.1.1', actor: { type: 'user', id: 'u_1', email: 'a@acme.com', role: 'admin' } });
    expect(a).toEqual({ actorId: 'u_1', actorType: 'user', actorRole: 'admin', actorEmail: 'a@acme.com', ip: '1.1.1.1' });
  });
  it('names the key for API-key calls (no email) and keeps the legacy env id', () => {
    expect(auth.auditActor({ ip: 'i', actor: { type: 'api-key', id: 'k1', role: 'member' } }))
      .toEqual({ actorId: 'k1', actorType: 'api-key', actorRole: 'member', ip: 'i' });
    expect(auth.auditActor({ ip: 'i' })).toMatchObject({ actorId: 'env-key', actorType: 'api-key' });
  });
});

describe('requireAdmin (operator key)', () => {
  it('fails closed when unset or wrong, passes on match', () => {
    const call = (hdr) => { const res = mkRes(), next = vi.fn(); auth.requireAdmin({ headers: { 'x-admin-key': hdr } }, res, next); return { res, next }; };
    delete process.env.AEGIS_ADMIN_KEY;
    expect(call('x').res.statusCode).toBe(403);
    process.env.AEGIS_ADMIN_KEY = 'op';
    expect(call('nope').res.statusCode).toBe(403);
    expect(call('op').next).toHaveBeenCalled();
  });
});
