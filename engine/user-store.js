/**
 * engine/user-store.js — per-tenant human users + dashboard sessions
 *
 * Redis layout
 * ────────────
 *   aegis:users:{tenantId}              Hash   userId → JSON(UserRecord)
 *   aegis:user-email:{tenantId}         Hash   lower(email) → userId
 *   aegis:session:{sha256(token)}       String JSON({ userId, tenantId }), TTL
 *   aegis:sso-code:{sha256(code)}       String JSON({ userId, tenantId }), 60 s, single-use
 *
 * UserRecord
 * ──────────
 *   { userId, tenantId, email, name, role, idpSub|null,
 *     createdAt, createdBy, lastLoginAt|null, disabledAt|null }
 *
 * Users are never deleted — disabling tombstones them so audit events that
 * reference a userId stay resolvable.
 *
 * Sessions hold only { userId, tenantId }; role and disabled state are read
 * from the user record on every request, so a role change or disable takes
 * effect immediately without hunting down sessions. Like API keys, only the
 * SHA-256 of the token is stored.
 */

import { createHash, randomBytes } from 'crypto';
import IORedis from 'ioredis';
import { assertTenantId } from './tenant.js';
import { isRole } from './rbac.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

const USERS   = (t) => `aegis:users:${t}`;
const EMAILS  = (t) => `aegis:user-email:${t}`;
const SESSION = (h) => `aegis:session:${h}`;
const CODE    = (h) => `aegis:sso-code:${h}`;

export const SESSION_PREFIX = 'aegs_';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const normEmail = (e) => String(e ?? '').trim().toLowerCase();

export function sessionTtlSeconds() {
  const h = Number(process.env.AEGIS_SESSION_TTL_HOURS);
  return Math.round((Number.isFinite(h) && h > 0 ? h : 8) * 3600);
}

// ─── Users ──────────────────────────────────────────────────────────────────

export async function createUser(tenantId, { email, name = '', role, idpSub = null, createdBy = null }) {
  assertTenantId(tenantId);
  const e = normEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('A valid email is required.');
  if (!isRole(role)) throw new Error(`Invalid role "${role}".`);

  const userId = `u_${randomBytes(6).toString('hex')}`;
  // HSETNX on the email index makes "one user per email per tenant" race-free.
  if (!(await redis.hsetnx(EMAILS(tenantId), e, userId))) {
    const err = new Error(`User "${e}" already exists in tenant "${tenantId}".`);
    err.code = 'USER_EXISTS';
    throw err;
  }
  const record = {
    userId, tenantId, email: e, name: String(name).slice(0, 200), role, idpSub,
    createdAt: Date.now(), createdBy, lastLoginAt: null, disabledAt: null,
  };
  await redis.hset(USERS(tenantId), userId, JSON.stringify(record));
  return record;
}

export async function getUser(tenantId, userId) {
  assertTenantId(tenantId);
  const raw = await redis.hget(USERS(tenantId), userId);
  return raw ? JSON.parse(raw) : null;
}

export async function getUserByEmail(tenantId, email) {
  assertTenantId(tenantId);
  const id = await redis.hget(EMAILS(tenantId), normEmail(email));
  return id ? getUser(tenantId, id) : null;
}

export async function listUsers(tenantId) {
  assertTenantId(tenantId);
  const all = await redis.hgetall(USERS(tenantId));
  return Object.values(all ?? {}).map((v) => JSON.parse(v)).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Patch role / disabled / idpSub / lastLoginAt. Returns the updated record,
 * or null when the user does not exist.
 * @param {{ role?: string, disabled?: boolean, idpSub?: string, lastLoginAt?: number }} patch
 */
export async function updateUser(tenantId, userId, patch) {
  const u = await getUser(tenantId, userId);
  if (!u) return null;
  if (patch.role !== undefined) {
    if (!isRole(patch.role)) throw new Error(`Invalid role "${patch.role}".`);
    u.role = patch.role;
  }
  if (patch.disabled !== undefined) u.disabledAt = patch.disabled ? (u.disabledAt ?? Date.now()) : null;
  if (patch.idpSub !== undefined) u.idpSub = patch.idpSub;
  if (patch.lastLoginAt !== undefined) u.lastLoginAt = patch.lastLoginAt;
  await redis.hset(USERS(tenantId), userId, JSON.stringify(u));
  return u;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** @returns {Promise<{ token: string, expiresAt: number }>} raw token is returned once. */
export async function createSession(tenantId, userId) {
  const token = SESSION_PREFIX + randomBytes(24).toString('hex');
  const ttl = sessionTtlSeconds();
  await redis.set(SESSION(sha(token)), JSON.stringify({ userId, tenantId }), 'EX', ttl);
  return { token, expiresAt: Date.now() + ttl * 1000 };
}

/**
 * Resolve a session token to its live, enabled user.
 * @returns {Promise<object|null>} UserRecord, or null (unknown / expired / disabled user)
 */
export async function resolveSession(token) {
  const raw = await redis.get(SESSION(sha(token)));
  if (!raw) return null;
  const { userId, tenantId } = JSON.parse(raw);
  const user = await getUser(tenantId, userId);
  return user && !user.disabledAt ? user : null;
}

export async function deleteSession(token) {
  await redis.del(SESSION(sha(token)));
}

// ─── One-time SSO exchange codes ────────────────────────────────────────────
// The callback redirects the browser with a code (never the session token) in
// the URL fragment; the SPA redeems it once over POST.

export async function createSsoCode(tenantId, userId) {
  const code = randomBytes(24).toString('hex');
  await redis.set(CODE(sha(code)), JSON.stringify({ userId, tenantId }), 'EX', 60);
  return code;
}

/** Atomic read-and-delete: a code can be redeemed exactly once. */
export async function redeemSsoCode(code) {
  const raw = await redis.getdel(CODE(sha(String(code ?? ''))));
  return raw ? JSON.parse(raw) : null;
}
