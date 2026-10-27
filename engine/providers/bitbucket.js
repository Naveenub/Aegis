/**
 * engine/providers/bitbucket.js — Bitbucket Cloud per-tenant auth (OAuth 2.0)
 *
 * Bitbucket Cloud has no installation model either; each tenant authorises an
 * OAuth consumer. Access tokens last 2 h. Refresh tokens are reusable (not
 * rotated), but a new one is honoured if the server returns it.
 *
 * Consumer setup (Workspace settings → OAuth consumers → Add consumer):
 *   Callback URL: https://<host>/bitbucket/callback
 *   Permissions:  Account: Read · Repositories: Read, Write · Pull requests: Write
 *
 * Env
 *   AEGIS_BITBUCKET_OAUTH_CLIENT_ID / AEGIS_BITBUCKET_OAUTH_CLIENT_SECRET   (consumer key / secret)
 *   AEGIS_BITBUCKET_REDIRECT_URI   optional; default ${AEGIS_PUBLIC_URL}/bitbucket/callback
 *   AEGIS_BITBUCKET_API_URL        default https://api.bitbucket.org/2.0
 *   AEGIS_BITBUCKET_WEB_URL        default https://bitbucket.org
 *
 * Bitbucket Server / Data Center uses a different API and is not supported here.
 */

import { tokenVaultConfigured } from '../token-vault.js';
import { oauthStateConfigured } from '../oauth-state.js';
import { cfg, postToken, apiGet, safeSegment } from './oauth-util.js';

const apiBase = () => cfg('AEGIS_BITBUCKET_API_URL', 'https://api.bitbucket.org/2.0').replace(/\/$/, '');
const webBase = () => cfg('AEGIS_BITBUCKET_WEB_URL', 'https://bitbucket.org').replace(/\/$/, '');

function redirectUri() {
  const explicit = cfg('AEGIS_BITBUCKET_REDIRECT_URI');
  if (explicit) return explicit;
  const pub = cfg('AEGIS_PUBLIC_URL').replace(/\/$/, '');
  return pub ? `${pub}/bitbucket/callback` : '';
}

const basic = () => ({ id: cfg('AEGIS_BITBUCKET_OAUTH_CLIENT_ID'), secret: cfg('AEGIS_BITBUCKET_OAUTH_CLIENT_SECRET') });

export const bitbucket = {
  name: 'bitbucket',
  kind: 'oauth',
  gitAuthUser: 'x-token-auth',
  webBase,
  apiBase,

  configured() {
    const b = basic();
    return Boolean(b.id && b.secret && oauthStateConfigured() && tokenVaultConfigured());
  },

  authorizeUrl(state) {
    const q = new URLSearchParams({ client_id: basic().id, response_type: 'code', state });
    const ru = redirectUri();
    if (ru) q.set('redirect_uri', ru);
    return `${webBase()}/site/oauth2/authorize?${q}`;
  },

  exchangeCode(code) {
    return postToken(`${webBase()}/site/oauth2/access_token`,
      { grant_type: 'authorization_code', code }, { basicAuth: basic(), label: 'Bitbucket' });
  },

  refresh(refreshToken) {
    return postToken(`${webBase()}/site/oauth2/access_token`,
      { grant_type: 'refresh_token', refresh_token: refreshToken }, { basicAuth: basic(), label: 'Bitbucket' });
  },

  async getAccount(token) {
    const u = await apiGet(`${apiBase()}/user`, token, 'Bitbucket');
    return { id: String(u.account_id ?? u.uuid), login: String(u.nickname ?? u.display_name ?? '') };
  },

  /** Repos where the user has write access (role=contributor or higher). */
  async listReposWithToken(token) {
    const out = [];
    let url = `${apiBase()}/repositories?role=contributor&pagelen=100`;
    for (let page = 1; page <= 5 && url; page++) {
      const data = await apiGet(url, token, 'Bitbucket');
      for (const r of data.values ?? []) {
        const [ws, slug] = String(r.full_name ?? '').split('/');
        if (!ws || !slug || !r.mainbranch?.name) continue; // empty repos can't be cloned
        out.push({
          fullName: r.full_name, owner: ws, name: slug,
          defaultBranch: r.mainbranch.name, private: Boolean(r.is_private), archived: false,
        });
      }
      // `next` is server-supplied: never follow it off the API host with our token attached.
      url = data.next && data.next.startsWith(apiBase()) ? data.next : null;
    }
    return out;
  },

  assertRepoName(owner, repo) {
    if (!safeSegment(owner) || !safeSegment(repo)) throw new Error(`Invalid repo identifier "${owner}/${repo}".`);
  },
};
