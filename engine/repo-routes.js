/**
 * engine/repo-routes.js — Per-tenant repo connect (GitHub App, GitLab, Bitbucket)
 *
 *   GET    /tenants/:id/repo              status
 *   POST   /tenants/:id/repo/connect      { provider?: "github"|"gitlab"|"bitbucket" }
 *                                         → { installUrl, provider }  (open in browser; default github)
 *   GET    /github/callback               GitHub redirect (state + OAuth code + installation_id)
 *   GET    /gitlab/callback               GitLab redirect (state + OAuth code)
 *   GET    /bitbucket/callback            Bitbucket redirect (state + OAuth code)
 *   GET    /tenants/:id/repo/available    repos the tenant's credential can see
 *   PUT    /tenants/:id/repo              { fullName, branch?, targetBranch? } select + clone
 *   DELETE /tenants/:id/repo              disconnect + delete clone (+ stored OAuth tokens)
 *   POST   /webhooks/github-app           installation lifecycle (githubAppWebhookRouter)
 *
 * GitLab / Bitbucket have no installation-revocation webhook: a revoked grant
 * is detected on the next token refresh, which marks the repo `revoked`.
 *
 * Mount:
 *   app.use(repoRouter);                                // JSON routes
 *   app.use('/webhooks', githubAppWebhookRouter);       // BEFORE webhookRouter (needs raw body)
 */

import express from 'express';
import { requireApiKey, assertTenantAccess } from '../middleware/auth.js';
import { recordAuditEvent } from './audit-log.js';
import {
  getRepoConfig, bindInstallation, bindProviderAccount, selectRepo, setRepoStatus, clearRepo,
  tenantForInstallation, releaseInstallation, consumeStateNonce,
} from './repo-store.js';
import {
  signState, verifyState, installUrl, getInstallation,
  listInstallationRepos, userCanAccessInstallation, verifyAppWebhook, forgetInstallation,
} from './github-app.js';
import { ensureTenantRepo, removeTenantRepoFiles, multiRepoMode, assertRepoName } from './tenant-repo.js';
import { getProvider, PROVIDER_NAMES } from './providers/index.js';
import { signOAuthState, verifyOAuthState } from './oauth-state.js';
import { saveCreds, loadCreds } from './cred-store.js';

export const repoRouter = express.Router();
export const githubAppWebhookRouter = express.Router();

const audit = (req, tenantId, action, detail = {}) =>
  recordAuditEvent(tenantId, {
    actorId: req.resolvedKeyId ?? 'env-key', action,
    resourceType: 'repo', resourceId: tenantId, detail,
  }).catch(err => console.error(`[audit] ${action}`, err));

const publicView = (c) => (c ? {
  provider: c.provider, status: c.status, account: c.accountLogin || null,
  owner: c.owner ?? null, repo: c.repo ?? null,
  defaultBranch: c.defaultBranch ?? null, targetBranch: c.targetBranch ?? null,
  cloneStatus: c.cloneStatus ?? 'none', cloneError: c.cloneError || null,
  installationId: c.installationId ?? null,
} : { status: 'none' });

const PROVIDER_LABEL = { github: 'GitHub App', gitlab: 'GitLab OAuth', bitbucket: 'Bitbucket OAuth' };

/** Per-tenant repos only exist in multi-repo mode; provider config is checked per route (assertConfigured). */
function requireEnabled(_req, res, next) {
  if (!multiRepoMode()) return res.status(501).json({ error: 'Set AEGIS_REPOS_BASE to enable per-tenant repos.' });
  next();
}

function assertConfigured(name, res) {
  if (getProvider(name).configured()) return true;
  res.status(501).json({ error: `${PROVIDER_LABEL[name]} is not configured.` });
  return false;
}

/** Repos the tenant's credential can see, for whichever provider it is connected to. */
async function listReposFor(tenantId, c) {
  const provider = getProvider(c.provider ?? 'github');
  return provider.listRepos(tenantId, c);
}

const hasCredential = (c) => (c.provider ?? 'github') === 'github' ? Boolean(c.installationId) : true;
const notConnected = (c) => `No ${PROVIDER_LABEL[c?.provider ?? 'github']} connection.`;

function cloneInBackground(tenantId) {
  ensureTenantRepo(tenantId).catch(err => console.error(`[repo] clone failed (${tenantId}):`, err.message));
}

repoRouter.get('/tenants/:id/repo', requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try { res.json(publicView(await getRepoConfig(req.params.id))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

repoRouter.post('/tenants/:id/repo/connect', requireApiKey, requireEnabled, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const name = req.body?.provider ?? 'github';
  if (!PROVIDER_NAMES.includes(name)) {
    return res.status(400).json({ error: `\`provider\` must be one of: ${PROVIDER_NAMES.join(', ')}.` });
  }
  if (!assertConfigured(name, res)) return;
  try {
    const url = name === 'github'
      ? installUrl(signState(req.params.id))
      : getProvider(name).authorizeUrl(signOAuthState(req.params.id, name));
    res.json({ installUrl: url, provider: name, expiresInSeconds: 600 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Browser redirect from GitHub — authenticated by signed state + OAuth code.
repoRouter.get('/github/callback', requireEnabled, async (req, res) => {
  if (!assertConfigured('github', res)) return;
  const { installation_id, setup_action, state, code } = req.query;
  try {
    const { tenantId, nonce } = verifyState(state);
    if (!(await consumeStateNonce(nonce))) return res.status(400).json({ error: 'State already used.' });

    if (setup_action === 'request') {
      return res.status(202).json({ status: 'awaiting-org-approval' });
    }
    if (!(await userCanAccessInstallation(code, installation_id))) {
      return res.status(403).json({ error: 'GitHub user cannot access this installation.' });
    }

    const inst = await getInstallation(installation_id);
    if (inst.suspended_at) return res.status(409).json({ error: 'Installation is suspended.' });

    await bindInstallation(tenantId, installation_id);

    const repos = await listInstallationRepos(installation_id);
    let status = 'select-repo';
    if (repos.length === 1) {
      const r = repos[0];
      assertRepoName(r.owner, r.name);
      await selectRepo(tenantId, { owner: r.owner, repo: r.name, defaultBranch: r.defaultBranch });
      cloneInBackground(tenantId);
      status = 'connected';
    }

    recordAuditEvent(tenantId, {
      actorId: `github-installation:${installation_id}`, action: 'repo.installed',
      resourceType: 'repo', resourceId: tenantId, detail: { installationId: String(installation_id), account: inst.account?.login },
    }).catch(() => {});

    const dest = process.env.AEGIS_POST_CONNECT_URL;
    if (dest) return res.redirect(`${dest}${dest.includes('?') ? '&' : '?'}repo=${status}`);
    res.json({ tenantId, status });
  } catch (err) {
    const code4 = err.code === 'INSTALLATION_TAKEN' ? 409 : /state/i.test(err.message) ? 400 : 500;
    console.error('[github/callback]', err.message);
    res.status(code4).json({ error: err.message });
  }
});

repoRouter.get('/tenants/:id/repo/available', requireApiKey, requireEnabled, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    const c = await getRepoConfig(req.params.id);
    if (!c || !hasCredential(c)) return res.status(409).json({ error: notConnected(c) });
    if (!assertConfigured(c.provider ?? 'github', res)) return;
    res.json({ repos: await listReposFor(req.params.id, c) });
  } catch (err) { res.status(err.code === 'PROVIDER_AUTH_REVOKED' ? 409 : 500).json({ error: err.message }); }
});

repoRouter.put('/tenants/:id/repo', requireApiKey, requireEnabled, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const { fullName, targetBranch } = req.body ?? {};
  try {
    const c = await getRepoConfig(req.params.id);
    if (!c || !hasCredential(c)) return res.status(409).json({ error: notConnected(c) });
    const providerName = c.provider ?? 'github';
    if (!assertConfigured(providerName, res)) return;

    // GitLab fullNames may include subgroups ("group/sub/project").
    const shape = providerName === 'gitlab' ? /^[^/\s]+(\/[^/\s]+)+$/ : /^[^/\s]+\/[^/\s]+$/;
    if (typeof fullName !== 'string' || !shape.test(fullName)) {
      return res.status(400).json({ error: '`fullName` ("owner/repo") is required.' });
    }

    const match = (await listReposFor(req.params.id, c)).find(r => r.fullName === fullName);
    if (!match) return res.status(404).json({ error: 'Repository is not accessible to this connection.' });
    assertRepoName(match.owner, match.name, providerName);

    if (c.repo && (c.owner !== match.owner || c.repo !== match.name)) {
      removeTenantRepoFiles(req.params.id); // switching repos: drop the old clone
    }
    await selectRepo(req.params.id, {
      owner: match.owner, repo: match.name, defaultBranch: match.defaultBranch, targetBranch,
    });
    cloneInBackground(req.params.id);
    audit(req, req.params.id, 'repo.selected', { fullName });
    res.status(202).json({ status: 'connected', cloneStatus: 'cloning', repo: fullName });
  } catch (err) { res.status(err.code === 'PROVIDER_AUTH_REVOKED' ? 409 : 500).json({ error: err.message }); }
});

repoRouter.delete('/tenants/:id/repo', requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    const c = await getRepoConfig(req.params.id);
    if (c?.installationId) forgetInstallation(c.installationId);
    // Best-effort: invalidate the OAuth grant at the provider before dropping our copy.
    const p = c?.provider && c.provider !== 'github' ? getProvider(c.provider) : null;
    if (p?.revoke) {
      const creds = await loadCreds(req.params.id, p.name);
      if (creds) await p.revoke(creds.accessToken).catch(() => {});
    }
    await clearRepo(req.params.id);
    if (multiRepoMode()) removeTenantRepoFiles(req.params.id);
    audit(req, req.params.id, 'repo.disconnected');
    res.status(204).end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GitLab / Bitbucket OAuth callbacks ──────────────────────────────────────

/**
 * Browser redirect from the provider — authenticated by the signed,
 * provider-bound, single-use `state` issued by POST /tenants/:id/repo/connect.
 * The authorisation code is exchanged server-side; tokens are sealed in
 * cred-store and never returned to the browser.
 */
function oauthCallback(name) {
  return async (req, res) => {
    if (!multiRepoMode()) return res.status(501).json({ error: 'Set AEGIS_REPOS_BASE to enable per-tenant repos.' });
    if (!assertConfigured(name, res)) return;
    const provider = getProvider(name);
    const { code, state, error } = req.query;
    try {
      const { tenantId, nonce } = verifyOAuthState(state, name);
      if (!(await consumeStateNonce(nonce))) return res.status(400).json({ error: 'State already used.' });
      if (error) return res.status(400).json({ error: 'Authorization was not granted.' });
      if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'Missing authorization code.' });

      const tokens = await provider.exchangeCode(code);
      const account = await provider.getAccount(tokens.accessToken);

      // A different account / provider than before means the old clone is not this tenant's repo any more.
      const prev = await getRepoConfig(tenantId);
      if (prev?.repo && (prev.provider !== name || prev.accountId !== account.id)) removeTenantRepoFiles(tenantId);
      if (prev?.installationId) forgetInstallation(prev.installationId);

      await bindProviderAccount(tenantId, name, account);
      await saveCreds(tenantId, name, tokens);

      const repos = await provider.listReposWithToken(tokens.accessToken);
      let status = 'select-repo';
      if (repos.length === 1) {
        const r = repos[0];
        assertRepoName(r.owner, r.name, name);
        await selectRepo(tenantId, { owner: r.owner, repo: r.name, defaultBranch: r.defaultBranch });
        cloneInBackground(tenantId);
        status = 'connected';
      }

      recordAuditEvent(tenantId, {
        actorId: `${name}-oauth:${account.id}`, action: 'repo.authorized',
        resourceType: 'repo', resourceId: tenantId, detail: { provider: name, account: account.login },
      }).catch(() => {});

      const dest = process.env.AEGIS_POST_CONNECT_URL;
      if (dest) return res.redirect(`${dest}${dest.includes('?') ? '&' : '?'}repo=${status}`);
      res.json({ tenantId, status });
    } catch (err) {
      const http = /state/i.test(err.message) ? 400 : err.code === 'OAUTH_EXCHANGE_FAILED' ? 400 : 500;
      console.error(`[${name}/callback]`, err.message);
      res.status(http).json({ error: err.message });
    }
  };
}

repoRouter.get('/gitlab/callback', oauthCallback('gitlab'));
repoRouter.get('/bitbucket/callback', oauthCallback('bitbucket'));

// ─── GitHub App webhook (installation lifecycle) ─────────────────────────────

githubAppWebhookRouter.post('/github-app', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  if (!verifyAppWebhook(req.body, req.get('x-hub-signature-256'))) return res.status(401).end();

  let p;
  try { p = JSON.parse(req.body.toString('utf-8')); } catch { return res.status(400).end(); }
  const event = req.get('x-github-event');
  const instId = p.installation?.id;

  try {
    const tenantId = instId ? await tenantForInstallation(instId) : null;
    if (tenantId) {
      if (event === 'installation') {
        if (p.action === 'deleted') {
          forgetInstallation(instId);
          await setRepoStatus(tenantId, 'revoked');
          await releaseInstallation(instId);
        } else if (p.action === 'suspend') {
          await setRepoStatus(tenantId, 'suspended');
        } else if (p.action === 'unsuspend') {
          await setRepoStatus(tenantId, 'connected');
        }
      } else if (event === 'installation_repositories' && p.action === 'removed') {
        const c = await getRepoConfig(tenantId);
        if ((p.repositories_removed ?? []).some(r => r.full_name === `${c?.owner}/${c?.repo}`)) {
          forgetInstallation(instId);
          await setRepoStatus(tenantId, 'revoked');
        }
      }
    }
    res.status(204).end();
  } catch (err) {
    console.error('[webhook/github-app]', err);
    res.status(500).end();
  }
});
