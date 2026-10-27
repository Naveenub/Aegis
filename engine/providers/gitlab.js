/**
 * engine/providers/gitlab.js — GitLab per-tenant auth (OAuth 2.0 authorization code)
 *
 * GitLab has no "installation" concept, so each tenant authorises Aegis as a
 * user via an OAuth application. Access tokens last 2 h; refresh tokens are
 * single-use and rotate, so refreshes are serialised (see providers/index.js).
 *
 * Application setup (GitLab → Preferences/Admin → Applications):
 *   Redirect URI: https://<host>/gitlab/callback
 *   Confidential: yes      Scopes: api
 *   (`api` is the narrowest scope that covers HTTPS push *and* MR creation.)
 *
 * Env
 *   AEGIS_GITLAB_OAUTH_CLIENT_ID / AEGIS_GITLAB_OAUTH_CLIENT_SECRET
 *   AEGIS_GITLAB_REDIRECT_URI   default: ${AEGIS_PUBLIC_URL}/gitlab/callback
 *   AEGIS_GITLAB_API_URL        self-hosted API base (default https://gitlab.com/api/v4)
 *   AEGIS_GITLAB_WEB_URL        self-hosted web base (default: API URL minus /api/v4)
 *
 * Repos are stored as owner = namespace path (may contain subgroups, e.g.
 * "group/sub"), repo = project path.
 */

import { tokenVaultConfigured } from '../token-vault.js';
import { oauthStateConfigured } from '../oauth-state.js';
import { cfg, postToken, apiGet, safeSegment } from './oauth-util.js';

const apiBase = () => cfg('AEGIS_GITLAB_API_URL', 'https://gitlab.com/api/v4').replace(/\/$/, '');
const webBase = () => (cfg('AEGIS_GITLAB_WEB_URL') || apiBase().replace(/\/api\/v4$/, '')).replace(/\/$/, '');

function redirectUri() {
  const explicit = cfg('AEGIS_GITLAB_REDIRECT_URI');
  if (explicit) return explicit;
  const pub = cfg('AEGIS_PUBLIC_URL').replace(/\/$/, '');
  return pub ? `${pub}/gitlab/callback` : '';
}

const clientCreds = () => ({
  client_id: cfg('AEGIS_GITLAB_OAUTH_CLIENT_ID'),
  client_secret: cfg('AEGIS_GITLAB_OAUTH_CLIENT_SECRET'),
});

export const gitlab = {
  name: 'gitlab',
  kind: 'oauth',
  gitAuthUser: 'oauth2',
  webBase,
  apiBase,

  configured() {
    const c = clientCreds();
    return Boolean(c.client_id && c.client_secret && redirectUri() && oauthStateConfigured() && tokenVaultConfigured());
  },

  authorizeUrl(state) {
    const q = new URLSearchParams({
      client_id: clientCreds().client_id, redirect_uri: redirectUri(),
      response_type: 'code', scope: 'api', state,
    });
    return `${webBase()}/oauth/authorize?${q}`;
  },

  exchangeCode(code) {
    return postToken(`${webBase()}/oauth/token`, {
      ...clientCreds(), code, grant_type: 'authorization_code', redirect_uri: redirectUri(),
    }, { label: 'GitLab' });
  },

  refresh(refreshToken) {
    return postToken(`${webBase()}/oauth/token`, {
      ...clientCreds(), refresh_token: refreshToken, grant_type: 'refresh_token', redirect_uri: redirectUri(),
    }, { label: 'GitLab' });
  },

  /** Best-effort: invalidate the grant on disconnect. */
  async revoke(accessToken) {
    await fetch(`${webBase()}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...clientCreds(), token: accessToken }).toString(),
    });
  },

  async getAccount(token) {
    const u = await apiGet(`${apiBase()}/user`, token, 'GitLab');
    return { id: String(u.id), login: String(u.username ?? '') };
  },

  /** Projects where the user is at least Developer (can push + open MRs). */
  async listReposWithToken(token) {
    const out = [];
    for (let page = 1; page <= 5; page++) {
      const data = await apiGet(
        `${apiBase()}/projects?membership=true&min_access_level=30&archived=false&simple=true&per_page=100&page=${page}`,
        token, 'GitLab',
      );
      for (const p of data) {
        if (!p.default_branch || !p.path_with_namespace) continue; // empty repos can't be cloned
        const i = p.path_with_namespace.lastIndexOf('/');
        out.push({
          fullName: p.path_with_namespace,
          owner: p.path_with_namespace.slice(0, i),
          name: p.path_with_namespace.slice(i + 1),
          defaultBranch: p.default_branch,
          archived: false,
        });
      }
      if (data.length < 100) break;
    }
    return out;
  },

  /** owner may be a subgroup path; every segment must be a safe identifier. */
  assertRepoName(owner, repo) {
    const segs = [...String(owner).split('/'), repo];
    if (segs.length > 21 || !segs.every(safeSegment)) throw new Error(`Invalid repo identifier "${owner}/${repo}".`);
  },
};
