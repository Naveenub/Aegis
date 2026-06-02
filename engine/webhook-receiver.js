/**
 * engine/webhook-receiver.js — Inbound webhook handler for GitHub / GitLab
 *
 * Mounts at POST /webhooks/:provider and translates external SCM events into
 * Aegis workflow submissions.  This closes the "no webhook receiver" gap: once
 * this module is wired into server.js, pushing a branch or merging a PR on
 * GitHub/GitLab can automatically trigger an Aegis run.
 *
 * Supported events
 * ────────────────
 *   GitHub  push                 → triggers on matching branch patterns
 *   GitHub  pull_request (opened/synchronize/reopened) → same
 *   GitLab  Push Hook            → triggers on matching branch patterns
 *   GitLab  Merge Request Hook   → triggers on open/update
 *
 * Environment variables
 * ─────────────────────
 *   AEGIS_WEBHOOK_SECRET_GITHUB   HMAC-SHA256 secret set in the GitHub webhook
 *                                 settings page.  When set, every request is
 *                                 signature-verified before processing.
 *
 *   AEGIS_WEBHOOK_SECRET_GITLAB   Token set in the GitLab webhook settings
 *                                 ("Secret token" field).  Verified via the
 *                                 X-Gitlab-Token header.
 *
 *   AEGIS_WEBHOOK_BRANCH_FILTER   Comma-separated glob patterns (minimatch).
 *                                 Only pushes/PRs targeting a matching branch
 *                                 are forwarded to Aegis.
 *                                 Default: "*" (accept all branches).
 *
 *   AEGIS_WEBHOOK_TENANT          Tenant ID to attribute inbound webhook jobs
 *                                 to.  Defaults to DEFAULT_TENANT.
 *
 * Usage (wire into server.js)
 * ───────────────────────────
 *   import { webhookRouter } from './engine/webhook-receiver.js';
 *   app.use('/webhooks', webhookRouter);
 *
 * Routes registered
 * ─────────────────
 *   POST /webhooks/github   — GitHub webhook endpoint
 *   POST /webhooks/gitlab   — GitLab webhook endpoint
 *
 * Exports
 * ───────
 *   webhookRouter           — Express Router (mount with app.use('/webhooks', ...))
 *   verifyGitHubSignature   — exported for unit-testing
 *   verifyGitLabToken       — exported for unit-testing
 *   parsePushPayload        — exported for unit-testing
 */

import crypto  from 'crypto';
import express from 'express';
import { runSystem } from './orchestrator.js';
import { DEFAULT_TENANT } from './tenant.js';

// ─── Config helpers ───────────────────────────────────────────────────────────

function cfg(key, fallback = '') {
  return (process.env[key] ?? fallback).trim();
}

function webhookTenant() {
  return cfg('AEGIS_WEBHOOK_TENANT') || DEFAULT_TENANT;
}

/**
 * Very small glob matcher — supports only the "*" wildcard (matches any
 * sequence of non-slash characters).  Sufficient for branch name patterns.
 * Full minimatch is not bundled to keep the dependency surface small.
 */
function matchesPattern(value, pattern) {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return re.test(value);
}

function branchAllowed(branch) {
  const raw = cfg('AEGIS_WEBHOOK_BRANCH_FILTER', '*');
  return raw.split(',').map(p => p.trim()).some(p => matchesPattern(branch, p));
}

// ─── Signature / token verification ──────────────────────────────────────────

/**
 * Verify the X-Hub-Signature-256 header sent by GitHub.
 *
 * @param {Buffer} rawBody  Raw request body bytes.
 * @param {string} sigHeader  Value of X-Hub-Signature-256.
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyGitHubSignature(rawBody, sigHeader, secret) {
  if (!secret) return true; // secret not configured → skip verification
  if (!sigHeader?.startsWith('sha256=')) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false; // length mismatch — definitely wrong
  }
}

/**
 * Verify the X-Gitlab-Token header.
 *
 * @param {string} tokenHeader
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyGitLabToken(tokenHeader, secret) {
  if (!secret) return true;
  if (!tokenHeader) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(tokenHeader), Buffer.from(secret));
  } catch {
    return false;
  }
}

// ─── Payload normalisation ────────────────────────────────────────────────────

/**
 * Extract a normalised { branch, commits, repoName, prNumber? } object from a
 * GitHub or GitLab payload so downstream logic doesn't branch on provider.
 *
 * @param {'github'|'gitlab'} provider
 * @param {string}            eventType   GitHub: X-GitHub-Event; GitLab: X-Gitlab-Event
 * @param {object}            payload     Parsed JSON body
 * @returns {{ branch: string, commits: string[], repoName: string, prNumber?: number } | null}
 *   null when the event is not actionable (e.g. PR closed, irrelevant action).
 */
export function parsePushPayload(provider, eventType, payload) {
  if (provider === 'github') {
    if (eventType === 'push') {
      const branch = (payload.ref ?? '').replace('refs/heads/', '');
      const commits = (payload.commits ?? []).map(c => c.id ?? c.sha).filter(Boolean);
      const repoName = payload.repository?.full_name ?? '';
      return branch ? { branch, commits, repoName } : null;
    }

    if (eventType === 'pull_request') {
      const action = payload.action;
      if (!['opened', 'synchronize', 'reopened'].includes(action)) return null;
      const branch   = payload.pull_request?.head?.ref ?? '';
      const repoName = payload.repository?.full_name ?? '';
      const prNumber = payload.pull_request?.number;
      const commits  = payload.pull_request?.head?.sha ? [payload.pull_request.head.sha] : [];
      return branch ? { branch, commits, repoName, prNumber } : null;
    }

    return null;
  }

  if (provider === 'gitlab') {
    const glEvent = (eventType ?? '').toLowerCase();

    if (glEvent === 'push hook' || glEvent === 'tag push hook') {
      const branch = (payload.ref ?? '').replace('refs/heads/', '');
      const commits = (payload.commits ?? []).map(c => c.id).filter(Boolean);
      const repoName = payload.project?.path_with_namespace ?? '';
      return branch ? { branch, commits, repoName } : null;
    }

    if (glEvent === 'merge request hook') {
      const action = payload.object_attributes?.action;
      if (!['open', 'update', 'reopen'].includes(action)) return null;
      const branch   = payload.object_attributes?.source_branch ?? '';
      const repoName = payload.project?.path_with_namespace ?? '';
      const prNumber = payload.object_attributes?.iid;
      const commits  = payload.object_attributes?.last_commit?.id
        ? [payload.object_attributes.last_commit.id]
        : [];
      return branch ? { branch, commits, repoName, prNumber } : null;
    }

    return null;
  }

  return null;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const webhookRouter = express.Router();

// Parse raw body for signature verification BEFORE the JSON parser runs.
// We attach it to req.rawBody so the JSON middleware can still parse req.body.
webhookRouter.use(
  express.raw({ type: '*/*', limit: '2mb' }),
  (req, _res, next) => {
    req.rawBody = req.body; // Buffer from express.raw
    try {
      req.body = JSON.parse(req.rawBody.toString('utf-8'));
    } catch {
      req.body = {};
    }
    next();
  },
);

// ── GitHub ────────────────────────────────────────────────────────────────────
webhookRouter.post('/github', async (req, res) => {
  const secret    = cfg('AEGIS_WEBHOOK_SECRET_GITHUB');
  const sigHeader = req.headers['x-hub-signature-256'] ?? '';
  const eventType = req.headers['x-github-event'] ?? '';

  if (!verifyGitHubSignature(req.rawBody, sigHeader, secret)) {
    return res.status(401).json({ error: 'Invalid GitHub webhook signature.' });
  }

  const parsed = parsePushPayload('github', eventType, req.body);

  if (!parsed) {
    // Acknowledge but take no action (e.g. PR closed, star event, etc.)
    return res.status(200).json({ accepted: false, reason: 'event not actionable' });
  }

  if (!branchAllowed(parsed.branch)) {
    return res.status(200).json({ accepted: false, reason: 'branch filtered out' });
  }

  try {
    const tenant = webhookTenant();
    const task   = buildTask(parsed, 'github');
    const result = await runSystem(task, tenant);
    return res.status(202).json({ accepted: true, workflowId: result.workflowId });
  } catch (err) {
    console.error('[webhook/github] runSystem error:', err);
    return res.status(500).json({ error: 'Failed to start workflow.' });
  }
});

// ── GitLab ────────────────────────────────────────────────────────────────────
webhookRouter.post('/gitlab', async (req, res) => {
  const secret      = cfg('AEGIS_WEBHOOK_SECRET_GITLAB');
  const tokenHeader = req.headers['x-gitlab-token'] ?? '';
  const eventType   = req.headers['x-gitlab-event'] ?? '';

  if (!verifyGitLabToken(tokenHeader, secret)) {
    return res.status(401).json({ error: 'Invalid GitLab webhook token.' });
  }

  const parsed = parsePushPayload('gitlab', eventType, req.body);

  if (!parsed) {
    return res.status(200).json({ accepted: false, reason: 'event not actionable' });
  }

  if (!branchAllowed(parsed.branch)) {
    return res.status(200).json({ accepted: false, reason: 'branch filtered out' });
  }

  try {
    const tenant = webhookTenant();
    const task   = buildTask(parsed, 'gitlab');
    const result = await runSystem(task, tenant);
    return res.status(202).json({ accepted: true, workflowId: result.workflowId });
  } catch (err) {
    console.error('[webhook/gitlab] runSystem error:', err);
    return res.status(500).json({ error: 'Failed to start workflow.' });
  }
});

// ─── Task builder ─────────────────────────────────────────────────────────────

/**
 * Convert a normalised push payload into a task description that runSystem()
 * can plan from.  Operators can override this by monkey-patching or subclassing
 * for more repo-specific descriptions.
 */
function buildTask(parsed, provider) {
  const { branch, commits, repoName, prNumber } = parsed;

  const commitSummary = commits.length
    ? `Commits: ${commits.slice(0, 5).join(', ')}${commits.length > 5 ? ` (+${commits.length - 5} more)` : ''}.`
    : '';

  const prNote = prNumber ? ` (${provider === 'gitlab' ? 'MR' : 'PR'} #${prNumber})` : '';

  return (
    `Incoming ${provider} push to branch "${branch}" in repo "${repoName}"${prNote}. ` +
    commitSummary +
    ' Review the changes, run relevant tests, and apply any necessary fixes or follow-up refactors.'
  );
}
