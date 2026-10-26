/**
 * tests/auth-billing-gate.test.js
 *
 * middleware/auth.js billing gate: pending/suspended tenants get 402 from
 * requireApiKey (unless the route opts out with allowInactiveTenant),
 * are treated as unauthenticated by optionalApiKey, env keys are never gated,
 * and a status-store failure fails closed (503).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupByHashMock = vi.fn();
vi.mock('../engine/key-store.js', () => ({
  hashKey: (k) => `h:${k}`,
  lookupByHash: lookupByHashMock,
}));

const getStatusMock = vi.fn();
vi.mock('../engine/tenant-registry.js', () => ({ getStatus: getStatusMock }));

let requireApiKey, optionalApiKey, allowInactiveTenant;

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  lookupByHashMock.mockReset().mockResolvedValue({ tenantId: 'acme', keyId: 'k1' });
  getStatusMock.mockReset().mockResolvedValue('active');
  ({ requireApiKey, optionalApiKey, allowInactiveTenant } = await import('../middleware/auth.js'));
});

const mkReq = (extra = {}) => ({ headers: { 'x-api-key': 'secret' }, query: {}, ...extra });
const mkRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

describe('requireApiKey billing gate', () => {
  it('passes an active tenant', async () => {
    const req = mkReq(), res = mkRes(), next = vi.fn();
    await requireApiKey(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.resolvedTenantId).toBe('acme');
  });

  it.each(['pending', 'suspended'])('returns 402 for a %s tenant', async (status) => {
    getStatusMock.mockResolvedValue(status);
    const res = mkRes(), next = vi.fn();
    await requireApiKey(mkReq(), res, next);
    expect(res.statusCode).toBe(402);
    expect(res.body.status).toBe(status);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a suspended tenant through when the route uses allowInactiveTenant', async () => {
    getStatusMock.mockResolvedValue('suspended');
    const req = mkReq(), res = mkRes(), next = vi.fn();
    allowInactiveTenant(req, res, () => {});
    await requireApiKey(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.resolvedTenantId).toBe('acme');
  });

  it('fails closed (503) when the status lookup errors', async () => {
    getStatusMock.mockRejectedValue(new Error('redis down'));
    const res = mkRes(), next = vi.fn();
    await requireApiKey(mkReq(), res, next);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('never gates static env keys', async () => {
    process.env.AEGIS_API_KEY = 'envkey';
    vi.resetModules();
    ({ requireApiKey } = await import('../middleware/auth.js'));
    lookupByHashMock.mockResolvedValue(null);
    getStatusMock.mockResolvedValue('suspended');
    const req = mkReq({ headers: { 'x-api-key': 'envkey' } }), res = mkRes(), next = vi.fn();
    await requireApiKey(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(getStatusMock).not.toHaveBeenCalled();
    delete process.env.AEGIS_API_KEY;
  });
});

describe('optionalApiKey billing gate', () => {
  it('authenticates an active tenant', async () => {
    const req = mkReq(), next = vi.fn();
    await optionalApiKey(req, mkRes(), next);
    expect(req.authenticated).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it.each(['pending', 'suspended'])('treats a %s tenant as unauthenticated', async (status) => {
    getStatusMock.mockResolvedValue(status);
    const req = mkReq(), next = vi.fn();
    await optionalApiKey(req, mkRes(), next);
    expect(req.authenticated).toBe(false);
    expect(req.resolvedTenantId).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });
});
