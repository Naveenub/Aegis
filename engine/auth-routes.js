/**
 * engine/auth-routes.js — identity routes: SSO sign-in, sessions, users, SSO config
 *
 *   GET    /auth/sso/:tenantId/login   Start OIDC sign-in (redirects to the IdP)
 *   GET    /auth/sso/callback          IdP redirect target → dashboard with a one-time code
 *   POST   /auth/sso/exchange          Redeem the code for a session token (once)
 *   GET    /auth/me                    Who am I? (API key or session) + permissions
 *   POST   /auth/logout                End the session
 *
 *   GET    /tenants/:id/users          List users                       [user.manage]
 *   POST   /tenants/:id/users          Pre-provision a user             [user.manage]
 *   PATCH  /tenants/:id/users/:userId  Change role / disable            [user.manage]
 *
 *   GET    /tenants/:id/sso            Read SSO config (no secret)      [sso.read]
 *   PUT    /tenants/:id/sso            Set SSO config                   [operator x-admin-key]
 *   DELETE /tenants/:id/sso            Remove SSO config                [operator x-admin-key]
 *
 * Env: AEGIS_PUBLIC_URL (redirect URI base), AEGIS_DASHBOARD_URL (where the
 * callback sends the browser; default "/"), AEGIS_SESSION_TTL_HOURS (default 8),
 * AEGIS_TOKEN_ENCRYPTION_KEY (seals the IdP client secret).
 */

import express from 'express';
import {
  requireApiKey, requirePermission, requireAdmin, assertTenantAccess, auditActor, extractKey,
} from '../middleware/auth.js';
import { taskRateLimiter } from '../middleware/rate-limit.js';
import { recordAuditEvent } from './audit-log.js';
import { getTenant } from './tenant-registry.js';
import { isRole, permissionsFor } from './rbac.js';
import {
  beginLogin, completeLogin, SsoError, setSsoConfig, getSsoConfig, deleteSsoConfig,
} from './sso.js';
import {
  SESSION_PREFIX, createUser, getUser, listUsers, updateUser,
  createSession, deleteSession, createSsoCode, redeemSsoCode,
} from './user-store.js';

export const authRouter = express.Router();

const COOKIE = 'aegis_sso_state';
const OPERATOR = { actorId: 'operator-key', actorType: 'api-key' };

const audit = (tenantId, evt) =>
  recordAuditEvent(tenantId, evt).catch((err) => console.error(`[audit] ${evt.action}`, err));

const publicUser = (u) => ({
  userId: u.userId, email: u.email, name: u.name, role: u.role,
  createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, disabledAt: u.disabledAt,
});

const dashboardBase = () => (process.env.AEGIS_DASHBOARD_URL ?? '').trim().replace(/\/$/, '');

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// ─── SSO sign-in ─────────────────────────────────────────────────────────────

authRouter.get('/auth/sso/:tenantId/login', taskRateLimiter, async (req, res) => {
  try {
    const { url, state } = await beginLogin(req.params.tenantId);
    res.cookie(COOKIE, state, {
      httpOnly: true, sameSite: 'lax', path: '/auth/sso', maxAge: 600_000,
      secure: (process.env.AEGIS_PUBLIC_URL ?? '').startsWith('https://'),
    });
    res.redirect(302, url);
  } catch (err) {
    // Same answer for "no such tenant" and "SSO not enabled" — don't leak which tenants exist.
    if (err.code === 'not_configured' || /^Invalid tenantId/.test(err.message)) {
      return res.status(404).json({ error: 'SSO is not available for this tenant.' });
    }
    console.error('[sso] begin failed', err);
    res.status(502).json({ error: 'SSO provider unavailable.' });
  }
});

authRouter.get('/auth/sso/callback', taskRateLimiter, async (req, res) => {
  res.clearCookie(COOKIE, { path: '/auth/sso' });
  const back = (fragment) => res.redirect(302, `${dashboardBase()}/#${fragment}`);
  if (req.query.error) return back('sso_error=idp_error'); // user cancelled / IdP refused

  try {
    const { user, tenantId } = await completeLogin({
      code: String(req.query.code ?? ''),
      state: String(req.query.state ?? ''),
      cookieState: readCookie(req, COOKIE),
    });
    audit(tenantId, {
      actorId: user.userId, actorType: 'user', actorEmail: user.email, actorRole: user.role, ip: req.ip,
      action: 'auth.login', resourceType: 'user', resourceId: user.userId, detail: { method: 'sso' },
    });
    back(`sso_code=${await createSsoCode(tenantId, user.userId)}`);
  } catch (err) {
    if (err instanceof SsoError) {
      console.warn(`[sso] login failed: ${err.code}${err.message !== err.code ? ` (${err.message})` : ''}`);
      if (err.code === 'denied' && err.tenantId) {
        audit(err.tenantId, {
          actorId: err.email ?? 'unknown', actorType: 'anonymous', ip: req.ip,
          action: 'auth.login_denied', resourceType: 'user', resourceId: err.email ?? 'unknown',
          detail: { method: 'sso', reason: err.message },
        });
      }
      return back(`sso_error=${err.code}`);
    }
    console.error('[sso] callback error', err);
    back('sso_error=failed');
  }
});

authRouter.post('/auth/sso/exchange', taskRateLimiter, async (req, res) => {
  try {
    const grant = await redeemSsoCode(req.body?.code);
    const user = grant && (await getUser(grant.tenantId, grant.userId));
    if (!user || user.disabledAt) return res.status(400).json({ error: 'Invalid or expired code.' });
    const { token, expiresAt } = await createSession(user.tenantId, user.userId);
    res.set('Cache-Control', 'no-store').json({ token, expiresAt, user: publicUser(user) });
  } catch (err) {
    console.error('[POST /auth/sso/exchange]', err);
    res.status(500).json({ error: 'Could not create session.' });
  }
});

// ─── Identity ────────────────────────────────────────────────────────────────

authRouter.get('/auth/me', requireApiKey, (req, res) => {
  res.json({ ...req.actor, permissions: permissionsFor(req.actor.role) });
});

authRouter.post('/auth/logout', requireApiKey, async (req, res) => {
  const token = extractKey(req);
  if (token.startsWith(SESSION_PREFIX)) {
    await deleteSession(token).catch((err) => console.error('[logout]', err));
    audit(req.resolvedTenantId, {
      ...auditActor(req), action: 'auth.logout', resourceType: 'user', resourceId: req.actor.id,
    });
  }
  res.status(204).end(); // API-key callers: nothing to end (use DELETE /tenants/:id/keys/:keyId)
});

// ─── Users ───────────────────────────────────────────────────────────────────

authRouter.get('/tenants/:id/users', requireApiKey, requirePermission('user.manage'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    res.json({ users: (await listUsers(req.params.id)).map(publicUser) });
  } catch (err) {
    console.error('[GET /tenants/:id/users]', err);
    res.status(500).json({ error: err.message });
  }
});

authRouter.post('/tenants/:id/users', requireApiKey, requirePermission('user.manage'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const { email, name, role = 'viewer' } = req.body ?? {};
  if (!isRole(role)) return res.status(400).json({ error: '`role` must be viewer, member or admin.' });
  try {
    const user = await createUser(req.params.id, { email, name, role, createdBy: { type: req.actor.type, id: req.actor.id } });
    audit(req.params.id, {
      ...auditActor(req), action: 'user.created', resourceType: 'user', resourceId: user.userId,
      detail: { email: user.email, role: user.role },
    });
    res.status(201).json(publicUser(user));
  } catch (err) {
    if (err.code === 'USER_EXISTS') return res.status(409).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

authRouter.patch('/tenants/:id/users/:userId', requireApiKey, requirePermission('user.manage'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const { role, disabled } = req.body ?? {};
  if (role === undefined && disabled === undefined) return res.status(400).json({ error: 'Provide `role` and/or `disabled`.' });
  if (role !== undefined && !isRole(role)) return res.status(400).json({ error: '`role` must be viewer, member or admin.' });
  if (disabled !== undefined && typeof disabled !== 'boolean') return res.status(400).json({ error: '`disabled` must be a boolean.' });
  try {
    const before = await getUser(req.params.id, req.params.userId);
    if (!before) return res.status(404).json({ error: 'User not found.' });
    const user = await updateUser(req.params.id, req.params.userId, { role, disabled });
    audit(req.params.id, {
      ...auditActor(req), action: 'user.updated', resourceType: 'user', resourceId: user.userId,
      detail: {
        email: user.email,
        ...(role !== undefined && { role: { from: before.role, to: user.role } }),
        ...(disabled !== undefined && { disabled }),
      },
    });
    res.json(publicUser(user));
  } catch (err) {
    console.error('[PATCH /tenants/:id/users/:userId]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SSO config ──────────────────────────────────────────────────────────────

authRouter.get('/tenants/:id/sso', requireApiKey, requirePermission('sso.read'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const cfg = await getSsoConfig(req.params.id).catch(() => null);
  cfg ? res.json(cfg) : res.status(404).json({ error: 'SSO is not configured for this tenant.' });
});

authRouter.put('/tenants/:id/sso', requireAdmin, async (req, res) => {
  try {
    if (!(await getTenant(req.params.id))) return res.status(404).json({ error: `Tenant "${req.params.id}" not found.` });
    const cfg = await setSsoConfig(req.params.id, req.body);
    audit(req.params.id, {
      ...OPERATOR, ip: req.ip, action: 'sso.configured', resourceType: 'tenant', resourceId: req.params.id,
      detail: { issuer: cfg.issuer, clientId: cfg.clientId, allowedDomains: cfg.allowedDomains, jitRole: cfg.jitRole, enabled: cfg.enabled },
    });
    res.json(cfg);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.delete('/tenants/:id/sso', requireAdmin, async (req, res) => {
  try {
    await deleteSsoConfig(req.params.id);
    audit(req.params.id, { ...OPERATOR, ip: req.ip, action: 'sso.removed', resourceType: 'tenant', resourceId: req.params.id });
    res.status(204).end();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
