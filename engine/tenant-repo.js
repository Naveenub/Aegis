/**
 * engine/tenant-repo.js — Per-tenant clone management
 *
 * Multi-repo mode is enabled by setting AEGIS_REPOS_BASE. Each tenant then gets:
 *   <AEGIS_REPOS_BASE>/<tenantId>/repo            full clone of the tenant's repo
 *   <AEGIS_REPOS_BASE>/.worktrees/<tenantId>/...  per-workflow worktrees
 *                                                 (override: AEGIS_WORKTREES)
 *
 * Without AEGIS_REPOS_BASE the legacy single-repo behaviour (AEGIS_REPO_ROOT)
 * is unchanged.
 *
 * Credentials: installation token injected per git process via GIT_CONFIG_*
 * env vars (not argv, not .git/config), so nothing is written into the clone
 * or visible to the sandbox mount.
 */

import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

import { assertTenantId } from './tenant.js';
import { getRepoConfig, patchRepo, withRepoLock } from './repo-store.js';
import { getInstallationToken, webBase } from './github-app.js';

const LEGACY_ROOT = () => path.resolve(process.env.AEGIS_REPO_ROOT ?? process.cwd());
const REPOS_BASE  = () => (process.env.AEGIS_REPOS_BASE ? path.resolve(process.env.AEGIS_REPOS_BASE) : null);

export const multiRepoMode = () => REPOS_BASE() !== null;

/** Sync, pure path: tenant's repo root (multi) or the shared root (legacy). */
export function repoRootFor(tenantId) {
  const base = REPOS_BASE();
  if (!base) return LEGACY_ROOT();
  assertTenantId(tenantId);
  return path.join(base, tenantId, 'repo');
}

export function worktreesBase() {
  if (process.env.AEGIS_WORKTREES) return path.resolve(process.env.AEGIS_WORKTREES);
  const base = REPOS_BASE();
  return base ? path.join(base, '.worktrees') : path.join(LEGACY_ROOT(), '.aegis-worktrees');
}

/** Root agents should scan; undefined in legacy mode so callers keep their default. */
export function scanRootFor(tenantId) {
  return multiRepoMode() ? repoRootFor(tenantId) : undefined;
}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
export function assertRepoName(owner, repo) {
  for (const v of [owner, repo]) {
    if (!NAME_RE.test(v) || v === '.' || v === '..') throw new Error(`Invalid repo identifier "${v}".`);
  }
}

// ─── Auth env ─────────────────────────────────────────────────────────────────

function authEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${webBase()}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

async function runGit(args, { cwd, env, token }) {
  // Lazy import: only needed in multi-repo mode.
  const { execFile } = await import('child_process');
  const execFileAsync = promisify(execFile);
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd, env, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000,
    });
    return stdout.trim();
  } catch (err) {
    const msg = String(err.stderr || err.message || '').trim();
    throw new Error(`git ${args[0]} failed: ${token ? msg.split(token).join('***') : msg}`);
  }
}

/**
 * Resolve repo access for a tenant. Throws code=TENANT_REPO_NOT_CONNECTED
 * unless the tenant has a connected repo.
 * @returns {Promise<{ root, cfg, token, env, fullName }>}
 */
export async function getRepoAccess(tenantId) {
  const cfg = await getRepoConfig(tenantId);
  if (!cfg || cfg.status !== 'connected' || !cfg.repo) {
    const e = new Error(`Tenant "${tenantId}" has no connected repository (status: ${cfg?.status ?? 'none'}).`);
    e.code = 'TENANT_REPO_NOT_CONNECTED';
    throw e;
  }
  assertRepoName(cfg.owner, cfg.repo);
  const token = await getInstallationToken(cfg.installationId, cfg.repo);
  return { root: repoRootFor(tenantId), cfg, token, env: authEnv(token), fullName: `${cfg.owner}/${cfg.repo}` };
}

// ─── Clone / fetch ────────────────────────────────────────────────────────────

const _lastFetch = new Map();

/**
 * Ensure the tenant's clone exists and is reasonably fresh.
 * Legacy mode: no-op returning the shared root and baseRef "HEAD".
 *
 * @returns {Promise<{ root: string, baseRef: string }>}
 */
export async function ensureTenantRepo(tenantId) {
  if (!multiRepoMode()) return { root: repoRootFor(tenantId), baseRef: 'HEAD' };

  const access = await getRepoAccess(tenantId);
  const { root, cfg, env, token } = access;
  const baseRef = `refs/remotes/origin/${cfg.defaultBranch}`;
  const cloned = fs.existsSync(path.join(root, '.git'));
  const interval = Number(process.env.AEGIS_REPO_FETCH_INTERVAL_MS ?? 30_000);

  if (cloned && Date.now() - (_lastFetch.get(tenantId) ?? 0) < interval) return { root, baseRef };

  await withRepoLock(tenantId, async () => {
    if (fs.existsSync(path.join(root, '.git'))) {
      await runGit(
        ['fetch', '--prune', 'origin', `+refs/heads/${cfg.defaultBranch}:${baseRef}`],
        { cwd: root, env, token },
      );
      _lastFetch.set(tenantId, Date.now());
      return;
    }

    await patchRepo(tenantId, { cloneStatus: 'cloning' });
    const tmp = `${root}.clone-${randomBytes(4).toString('hex')}`;
    try {
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.rmSync(root, { recursive: true, force: true });
      await runGit(
        ['clone', '--single-branch', '--branch', cfg.defaultBranch, '--',
          `${webBase()}/${cfg.owner}/${cfg.repo}.git`, tmp],
        { env, token },
      );
      await runGit(['config', 'user.name',  process.env.AEGIS_GIT_AUTHOR_NAME  ?? 'Aegis'], { cwd: tmp, env });
      await runGit(['config', 'user.email', process.env.AEGIS_GIT_AUTHOR_EMAIL ?? 'aegis@users.noreply.github.com'], { cwd: tmp, env });
      fs.renameSync(tmp, root);
      _lastFetch.set(tenantId, Date.now());
      await patchRepo(tenantId, { cloneStatus: 'ready', cloneError: '' });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      await patchRepo(tenantId, { cloneStatus: 'failed', cloneError: String(err.message).slice(0, 500) });
      throw err;
    }
  });

  return { root, baseRef };
}

/** Delete a tenant's clone + worktrees (disconnect). */
export function removeTenantRepoFiles(tenantId) {
  assertTenantId(tenantId);
  _lastFetch.delete(tenantId);
  const base = REPOS_BASE();
  if (base) fs.rmSync(path.join(base, tenantId), { recursive: true, force: true });
  fs.rmSync(path.join(worktreesBase(), tenantId), { recursive: true, force: true });
}

/** Authenticated push from the tenant clone. */
export async function pushFromTenantRepo(tenantId, branch, { force = false } = {}) {
  const { root, env, token } = await getRepoAccess(tenantId);
  const ref = `refs/heads/${branch}`;
  await runGit(['push', ...(force ? ['--force-with-lease'] : []), 'origin', `${ref}:${ref}`], { cwd: root, env, token });
}
