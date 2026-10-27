/**
 * engine/providers/index.js — Git hosting provider registry for per-tenant repos
 *
 * Every provider exposes the same surface to tenant-repo.js / repo-routes.js:
 *
 *   name, webBase(), gitAuthUser            how git authenticates over HTTPS
 *   configured()                            all env present
 *   getToken(tenantId, cfg)                 a currently valid access token
 *   listRepos(tenantId, cfg)                repos the tenant's credential can use
 *   assertRepoName(owner, repo)
 *
 * github     — App installation tokens, repo-scoped, nothing stored.
 * gitlab,
 * bitbucket  — OAuth; encrypted tokens in cred-store, refreshed on demand.
 */

import { getInstallationToken, listInstallationRepos, githubAppConfigured, webBase as githubWebBase } from '../github-app.js';
import { loadCreds, saveCreds, deleteCreds, withCredLock } from '../cred-store.js';
import { setRepoStatus } from '../repo-store.js';
import { gitlab } from './gitlab.js';
import { bitbucket } from './bitbucket.js';

export const PROVIDER_NAMES = ['github', 'gitlab', 'bitbucket'];

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

const github = {
  name: 'github',
  kind: 'app',
  gitAuthUser: 'x-access-token',
  webBase: () => githubWebBase(),
  configured: () => githubAppConfigured(),
  getToken: (_tenantId, cfg) => getInstallationToken(cfg.installationId, cfg.repo),
  listRepos: (_tenantId, cfg) => listInstallationRepos(cfg.installationId),
  assertRepoName(owner, repo) {
    for (const v of [owner, repo]) {
      if (!NAME_RE.test(v) || v === '.' || v === '..') throw new Error(`Invalid repo identifier "${v}".`);
    }
  },
};

const REGISTRY = { github, gitlab, bitbucket };

/** @throws on unknown provider */
export function getProvider(name = 'github') {
  const p = REGISTRY[name];
  if (!p) throw new Error(`Unknown git provider "${name}".`);
  return p;
}

// ─── OAuth token lifecycle ───────────────────────────────────────────────────

const REFRESH_SKEW_MS = 2 * 60_000;
const fresh = (c) => c.expiresAt - REFRESH_SKEW_MS > Date.now();

function revokedError(provider) {
  const e = new Error(`${provider} authorisation is missing or was revoked — reconnect the repository.`);
  e.code = 'PROVIDER_AUTH_REVOKED';
  return e;
}

/**
 * A valid access token for an OAuth tenant, refreshing (under a lock) when it
 * is about to expire. If the provider rejects the refresh token, the stored
 * credentials are dropped and the repo is marked revoked.
 */
async function getOAuthToken(provider, tenantId) {
  let c = await loadCreds(tenantId, provider.name);
  if (!c) throw revokedError(provider.name);
  if (fresh(c)) return c.accessToken;

  return withCredLock(tenantId, async () => {
    c = await loadCreds(tenantId, provider.name); // another worker may have refreshed already
    if (!c) throw revokedError(provider.name);
    if (fresh(c)) return c.accessToken;
    if (!c.refreshToken) {
      await deleteCreds(tenantId);
      await setRepoStatus(tenantId, 'revoked');
      throw revokedError(provider.name);
    }

    let next;
    try {
      next = await provider.refresh(c.refreshToken);
    } catch (err) {
      if (err.code === 'OAUTH_INVALID_GRANT') {
        await deleteCreds(tenantId);
        await setRepoStatus(tenantId, 'revoked');
        throw revokedError(provider.name);
      }
      throw err; // transient (network / 5xx): keep credentials, caller retries
    }
    await saveCreds(tenantId, provider.name, {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? c.refreshToken, // GitLab rotates; Bitbucket reuses
      expiresAt: next.expiresAt,
    });
    return next.accessToken;
  });
}

for (const p of [gitlab, bitbucket]) {
  p.getToken = (tenantId) => getOAuthToken(p, tenantId);
  p.listRepos = async (tenantId) => p.listReposWithToken(await getOAuthToken(p, tenantId));
}
