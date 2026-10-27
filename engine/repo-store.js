/**
 * engine/repo-store.js — Per-tenant repository binding (metadata only, no secrets)
 *
 * Redis layout:
 *   aegis:tenant:repo:{tenantId}   Hash  provider, installationId, owner, repo,
 *                                        defaultBranch, targetBranch, status,
 *                                        cloneStatus, cloneError, connectedAt
 *   aegis:gh-installation:{id}     String tenantId (one installation → one tenant)
 *   aegis:gh-state:{nonce}         String "1" (single-use OAuth state, 15 min)
 *   aegis:repo-lock:{tenantId}     String lock token (clone/fetch mutual exclusion)
 *
 * status:      pending | connected | suspended | revoked
 * cloneStatus: none | cloning | ready | failed
 */

import IORedis from 'ioredis';
import { randomBytes } from 'crypto';
import { assertTenantId } from './tenant.js';

const redis = new IORedis(process.env.REDIS_URL || undefined, {
  lazyConnect:          true,
  enableOfflineQueue:   false,
  maxRetriesPerRequest: 1,
  connectTimeout:       3000,
  retryStrategy:        () => null,
});
redis.on('error', () => {});

const REPO_KEY    = (t) => `aegis:tenant:repo:${t}`;
const INSTALL_KEY = (i) => `aegis:gh-installation:${i}`;
const STATE_KEY   = (n) => `aegis:gh-state:${n}`;
const LOCK_KEY    = (t) => `aegis:repo-lock:${t}`;

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export async function getRepoConfig(tenantId) {
  assertTenantId(tenantId);
  const h = await redis.hgetall(REPO_KEY(tenantId));
  return h && Object.keys(h).length ? { tenantId, ...h } : null;
}

/**
 * Bind a GitHub App installation to a tenant. One installation may belong to
 * exactly one tenant — prevents tenant B from claiming tenant A's installation.
 * @throws {Error} code=INSTALLATION_TAKEN when owned by another tenant
 */
export async function bindInstallation(tenantId, installationId) {
  assertTenantId(tenantId);
  const id = String(installationId);
  if (!/^\d{1,20}$/.test(id)) throw new Error('Invalid installation id.');

  const claimed = await redis.set(INSTALL_KEY(id), tenantId, 'NX');
  if (!claimed) {
    const owner = await redis.get(INSTALL_KEY(id));
    if (owner !== tenantId) {
      const e = new Error('Installation is already bound to another tenant.');
      e.code = 'INSTALLATION_TAKEN';
      throw e;
    }
  }

  const prev = await redis.hget(REPO_KEY(tenantId), 'installationId');
  if (prev && prev !== id) await redis.del(INSTALL_KEY(prev));

  await redis.hset(REPO_KEY(tenantId), {
    provider: 'github', installationId: id, status: 'pending', cloneStatus: 'none',
  });
  await redis.hdel(REPO_KEY(tenantId), 'owner', 'repo', 'defaultBranch', 'cloneError');
}

export async function selectRepo(tenantId, { owner, repo, defaultBranch, targetBranch }) {
  assertTenantId(tenantId);
  await redis.hset(REPO_KEY(tenantId), {
    owner, repo, defaultBranch,
    targetBranch: targetBranch ?? defaultBranch,
    status: 'connected', cloneStatus: 'none', connectedAt: String(Date.now()),
  });
  await redis.hdel(REPO_KEY(tenantId), 'cloneError');
}

export async function patchRepo(tenantId, fields) {
  assertTenantId(tenantId);
  await redis.hset(REPO_KEY(tenantId), fields);
}

export async function setRepoStatus(tenantId, status) {
  await patchRepo(tenantId, { status });
}

export async function clearRepo(tenantId) {
  assertTenantId(tenantId);
  const inst = await redis.hget(REPO_KEY(tenantId), 'installationId');
  if (inst) await redis.del(INSTALL_KEY(inst));
  await redis.del(REPO_KEY(tenantId));
}

export async function tenantForInstallation(installationId) {
  return (await redis.get(INSTALL_KEY(String(installationId)))) ?? null;
}

/** Releases an installation index entry (App uninstalled). Keeps tenant record. */
export async function releaseInstallation(installationId) {
  await redis.del(INSTALL_KEY(String(installationId)));
}

/** Single-use OAuth state nonce. Returns false on replay. */
export async function consumeStateNonce(nonce) {
  return (await redis.set(STATE_KEY(nonce), '1', 'EX', 900, 'NX')) === 'OK';
}

/**
 * Cross-process lock for clone/fetch. Redlock's 10 s TTL is too short for a
 * clone, so this uses its own long-TTL token lock.
 */
export async function withRepoLock(tenantId, fn, { ttlMs = 300_000, waitMs = 120_000 } = {}) {
  assertTenantId(tenantId);
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + waitMs;
  while (!(await redis.set(LOCK_KEY(tenantId), token, 'PX', ttlMs, 'NX'))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for repo lock (${tenantId}).`);
    await new Promise(r => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    try { await redis.eval(RELEASE_LUA, 1, LOCK_KEY(tenantId), token); } catch { /* expired */ }
  }
}
