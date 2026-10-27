/**
 * engine/repo-routes.js — Per-tenant repo connect (GitHub App)
 *
 *   GET    /tenants/:id/repo              status
 *   POST   /tenants/:id/repo/connect      → { installUrl }  (open in browser)
 *   GET    /github/callback               GitHub redirect (state + OAuth code)
 *   GET    /tenants/:id/repo/available    repos the installation can see
 *   PUT    /tenants/:id/repo              { fullName, branch?, targetBranch? } select + clone
 *   DELETE /tenants/:id/repo              disconnect + delete clone
 *   POST   /webhooks/github-app           installation lifecycle (githubAppWebhookRouter)
 *
 * Mount:
 *   app.use(repoRouter);                                // JSON routes
 *   app.use('/webhooks', githubAppWebhookRouter);       // BEFORE webhookRouter (needs raw body)
 */

import express from 'express';
import { requireApiKey, assertTenantAccess } from '../middleware/auth.js';
import { recordAuditEvent } from './audit-log.js';
import {
  getRepoConfig, bindInstallation, selectRepo, setRepoStatus, clearRepo,
  tenantForInstallation, releaseInstallation, consumeStateNonce,
} from './repo-store.js';
import {
  githubAppConfigured, signState, verifyState, installUrl, getInstallation,
  listInstallationRepos, userCanAccessInstallation, verifyAppWebhook, forgetInstallation,
} from './github-app.js';
import { ensureTenantRepo, removeTenantRepoFiles, multiRepoMode, assertRepoName } from './tenant-repo.js';

export const repoRouter = express.Router();
export const githubAppWebhookRouter = express.Router();

const audit = (req, tenantId, action, detail = {}) =>
  recordAuditEvent(tenantId, {
    actorId: req.resolvedKeyId ?? 'env-key', action,
    resourceType: 'repo', resourceId: tenantId, detail,
  }).catch(err => console.error(`[audit] ${action}`, err));

const publicView = (c) => (c ? {
  provider: c.provider, status: c.status, owner: c.owner ?? null, repo: c.repo ?? null,
  defaultBranch: c.defaultBranch ?? null, targetBranch: c.targetBranch ?? null,
  cloneStatus: c.cloneStatus ?? 'none', cloneError: c.cloneError || null,
  installationId: c.installationId ?? null,
} : { status: 'none' });

function requireEnabled(_req, res, next) {
  if (!multiRepoMode()) return res.status(501).json({ error: 'Set AEGIS_REPOS_BASE to enable per-tenant repos.' });
  if (!githubAppConfigured()) return res.status(501).json({ error: 'GitHub App is not configured.' });
  next();
}

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
  try {
    res.json({ installUrl: installUrl(signState(req.params.id)), expiresInSeconds: 600 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Browser redirect from GitHub — authenticated by signed state + OAuth code.
repoRouter.get('/github/callback', requireEnabled, async (req, res) => {
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
    if (!c?.installationId) return res.status(409).json({ error: 'No GitHub installation connected.' });
    res.json({ repos: await listInstallationRepos(c.installationId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

repoRouter.put('/tenants/:id/repo', requireApiKey, requireEnabled, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const { fullName, targetBranch } = req.body ?? {};
  if (typeof fullName !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) {
    return res.status(400).json({ error: '`fullName` ("owner/repo") is required.' });
  }
  try {
    const c = await getRepoConfig(req.params.id);
    if (!c?.installationId) return res.status(409).json({ error: 'No GitHub installation connected.' });

    const match = (await listInstallationRepos(c.installationId)).find(r => r.fullName === fullName);
    if (!match) return res.status(404).json({ error: 'Repository is not accessible to this installation.' });
    assertRepoName(match.owner, match.name);

    if (c.repo && (c.owner !== match.owner || c.repo !== match.name)) {
      removeTenantRepoFiles(req.params.id); // switching repos: drop the old clone
    }
    await selectRepo(req.params.id, {
      owner: match.owner, repo: match.name, defaultBranch: match.defaultBranch, targetBranch,
    });
    cloneInBackground(req.params.id);
    audit(req, req.params.id, 'repo.selected', { fullName });
    res.status(202).json({ status: 'connected', cloneStatus: 'cloning', repo: fullName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

repoRouter.delete('/tenants/:id/repo', requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    const c = await getRepoConfig(req.params.id);
    if (c?.installationId) forgetInstallation(c.installationId);
    await clearRepo(req.params.id);
    if (multiRepoMode()) removeTenantRepoFiles(req.params.id);
    audit(req, req.params.id, 'repo.disconnected');
    res.status(204).end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
