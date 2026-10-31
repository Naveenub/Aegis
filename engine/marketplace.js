/**
 * engine/marketplace.js — GitHub Marketplace purchase events
 *
 *   POST /webhooks/github-marketplace
 *
 * Configure this URL (and AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET) in the
 * Marketplace listing's webhook settings. Maps the purchasing account to the
 * tenant that installed the App on it, then moves the tenant between tiers.
 *
 *   AEGIS_GITHUB_MARKETPLACE_PLANS  JSON, plan name → tier, e.g. {"Team":"team","Pro":"pro"}
 *
 * purchased/changed → tier + active status; cancelled → free tier.
 * pending_change* are ignored (GitHub sends `changed` when it takes effect).
 * An unmapped plan or an account with no linked tenant is logged and acknowledged
 * (200) without changes — redeliver from the listing's webhook page after fixing.
 */

import express from 'express';
import crypto from 'crypto';
import { appJwt } from './github-app.js';
import { tenantForInstallation } from './repo-store.js';
import { setTier, setStatus, markFirstPaid } from './tenant-registry.js';
import { setQuota } from './tenant-quota.js';
import { getTierConfig, SIGNUP_DEFAULT_TIER } from './billing/tiers.js';
import { recordAuditEvent } from './audit-log.js';
import { claimOnce } from './trigger-store.js';

export const marketplaceRouter = express.Router();

export function verifyGithubSignature256(rawBody, header, secret) {
  if (!secret || typeof header !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function planToTier(planName) {
  try {
    const map = JSON.parse(process.env.AEGIS_GITHUB_MARKETPLACE_PLANS ?? '{}');
    const tier = map[planName];
    return typeof tier === 'string' && tier ? tier : null;
  } catch { return null; }
}

const apiBase = () => (process.env.AEGIS_GITHUB_API_URL ?? 'https://api.github.com').trim().replace(/\/$/, '');

/** Installation of this App on the purchasing account → installation id (or null). */
export async function installationForAccount(account) {
  const kind = account.type === 'Organization' ? 'orgs' : 'users';
  const res = await fetch(`${apiBase()}/${kind}/${encodeURIComponent(account.login)}/installation`, {
    headers: { Authorization: `Bearer ${appJwt()}`, Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`installation lookup HTTP ${res.status}`);
  return (await res.json()).id ?? null;
}

async function applyTier(tenantId, tier) {
  await setTier(tenantId, tier);
  await setQuota(tenantId, getTierConfig(tier).quota);
}

marketplaceRouter.post('/github-marketplace', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const secret = (process.env.AEGIS_GITHUB_MARKETPLACE_WEBHOOK_SECRET ?? '').trim();
  if (!verifyGithubSignature256(req.body, req.get('x-hub-signature-256'), secret)) return res.status(401).end();

  let p;
  try { p = JSON.parse(req.body.toString('utf-8')); } catch { return res.status(400).end(); }
  if (req.get('x-github-event') !== 'marketplace_purchase') return res.status(200).json({ ignored: true });

  try {
    const delivery = req.get('x-github-delivery');
    if (delivery && !(await claimOnce(`mkt:${delivery}`, 86400))) return res.status(200).json({ duplicate: true });

    const action = p.action;
    const purchase = p.marketplace_purchase;
    if (!['purchased', 'changed', 'cancelled'].includes(action) || !purchase?.account?.login) {
      return res.status(200).json({ ignored: true });
    }

    const installationId = await installationForAccount(purchase.account);
    const tenantId = installationId ? await tenantForInstallation(installationId) : null;
    if (!tenantId) {
      console.warn(`[marketplace] ${action} for ${purchase.account.login}: no linked tenant — install the App and connect a repo, then redeliver.`);
      return res.status(200).json({ applied: false, reason: 'no linked tenant' });
    }

    let tier;
    if (action === 'cancelled') tier = SIGNUP_DEFAULT_TIER;
    else {
      tier = planToTier(purchase.plan?.name);
      if (!tier) {
        console.warn(`[marketplace] plan "${purchase.plan?.name}" is not in AEGIS_GITHUB_MARKETPLACE_PLANS`);
        return res.status(200).json({ applied: false, reason: 'unmapped plan' });
      }
    }

    await applyTier(tenantId, tier);
    if (action !== 'cancelled') { await setStatus(tenantId, 'active'); await markFirstPaid(tenantId); }

    recordAuditEvent(tenantId, {
      actorId: 'github-marketplace', actorType: 'trigger', action: `billing.marketplace.${action}`,
      resourceType: 'tenant', resourceId: tenantId, detail: { plan: purchase.plan?.name, tier },
    }).catch(() => {});
    console.warn(`[marketplace] ${action} tenant=${tenantId} tier=${tier}`);
    res.status(200).json({ applied: true, tier });
  } catch (err) {
    console.error('[marketplace]', err.message);
    res.status(500).end(); // GitHub will not auto-retry, but a manual redeliver is possible
  }
});
