/**
 * server.js — Aegis API server
 *
 * Starts the Express HTTP server and wires together all engine modules,
 * middleware, and route handlers.
 *
 * Environment variables
 * ─────────────────────
 *   PORT                  HTTP port to listen on              (default: 3000)
 *   AEGIS_API_KEY_DEFAULT Static API key for default tenant
 *   AEGIS_API_KEY_{TID}   Per-tenant static key
 *   (See .env.example for the full list.)
 *
 * Routes
 * ──────
 *   GET    /health                              Liveness check (no auth)
 *   POST   /task                               Submit a new task
 *   POST   /resume                             Resume a paused workflow
 *   POST   /cancel                             Cancel a running workflow
 *   GET    /workflows                          List workflows (filterable)
 *   GET    /workflows/:workflowId              Get workflow status + steps
 *   POST   /workflows/:workflowId/steps/:stepId/rewind   Step-level undo
 *   GET    /workflows/:workflowId/rewind-history         Rewind audit trail
 *   POST   /templates                          Save a task+plan as a reusable template
 *   GET    /templates/:id                      Fetch a saved template
 *   POST   /templates/:id/run                  Run a saved template (skips the planner)
 *   GET    /concurrency/:workflowId            Live concurrency slot status
 *   GET    /jobs                               List jobs (tenant-scoped)
 *   GET    /jobs/:jobId                        Get a single job
 *   GET    /dlq                                List dead-letter entries (tenant-scoped)
 *   GET    /traces                             List workflow traces
 *   GET    /traces/:traceId                    Get a single trace
 *   GET    /review-queue                       Pending human-review items
 *   POST   /review-queue/resolve               Resolve a review item
 *   GET    /metrics                            Prometheus text export
 *   GET    /metrics/json                       OTEL-compatible JSON export
 *   GET    /api/metrics                        Structured metrics (dashboard)
 *   GET    /dashboard                          Observability UI (HTML)
 *   GET    /app/*                              React dashboard SPA (usage & billing, tenants, users; built from dashboard/)
 *   GET    /events                             SSE live-push stream (metrics + workflows)
 *   GET    /                                   Marketing landing page (HTML)
 *   GET    /get-started                        Self-serve signup page (Stripe.js, HTML)
 *   GET    /terms, /privacy, /dpa, /security   Legal + trust pages (HTML)
 *   GET    /subprocessors[.json]               Subprocessor list (page / machine-readable)
 *   GET|PUT /tenants/:id/retention             Retention policy + zero-retention mode
 *   POST   /tenants/:id/data-deletion          Delete workspace content on request
 *   GET    /signup/config                      Public signup config (Stripe publishable key)
 *   POST   /signup                             Self-serve signup (Stripe customer+sub, tenant, API key)
 *   POST   /billing/portal                     Stripe billing-portal URL (works while pending/suspended)
 *   POST   /billing/plan                       Change plan { tier, email? }: free→paid, upgrade now, downgrade/cancel at period end
 *   GET    /tenants                            List registered tenants
 *   POST   /tenants                            Register a new tenant
 *   GET    /tenants/:id                        Get tenant metadata
 *   GET    /tenants/:id/billing                 Tier + usage vs. included allowance
 *   GET    /tenants/:id/keys                   List API keys for a tenant
 *   POST   /tenants/:id/keys                   Create an API key
 *   DELETE /tenants/:id/keys/:kid              Revoke an API key
 *   GET    /tenants/:id/audit-log              Query the compliance audit trail
 *   GET    /tenants/:id/audit-log/export       Export audit trail (JSON or CSV)
 *
 * Identity & access (engine/auth-routes.js; roles in engine/rbac.js):
 *   GET    /auth/sso/:tenantId/login           Start OIDC sign-in
 *   GET    /auth/sso/callback                  IdP redirect target
 *   POST   /auth/sso/exchange                  One-time code → session token
 *   GET    /auth/me                            Current identity + permissions
 *   POST   /auth/logout                        End the session
 *   GET|POST /tenants/:id/users                List / pre-provision users
 *   PATCH  /tenants/:id/users/:userId          Change role / disable
 *   GET|PUT|DELETE /tenants/:id/sso            SSO config (PUT/DELETE: operator x-admin-key)
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import express           from 'express';

// ─── Engine imports ───────────────────────────────────────────────────────────
import { runSystem, runTemplate, validatePlan } from './engine/orchestrator.js';
import { saveTemplate, getTemplate, getTemplateVersions, diffTemplateTasks } from './engine/template-store.js';
import { getJob, listJobs }                  from './engine/job-store.js';
import { getTrace, listTraces }              from './engine/tracer.js';
import { getMetrics, renderPrometheus, renderOtel } from './engine/metrics.js';
import { getWorkflowStatus, listWorkflows, resumeWorkflow, cancelWorkflow, getReviewQueue, resolveReview, resetStepForRetry, updateStep, rewindStep, getRewindHistory } from './engine/workflow-store.js';
import { addStep, Priority, getDeadLetterQueue } from './engine/queue.js';
import { slotStatus }                        from './engine/concurrency.js';
import { revertStepCommit, ensureWorkflowBranch } from './engine/git.js';
import { listTenants, getTenant, registerTenant, seedTenantsFromEnv, setTier, getStripeCustomerId, setSpendConfig, setRetentionConfig } from './engine/tenant-registry.js';
import { setQuota } from './engine/tenant-quota.js';
import { getTierConfig, DEFAULT_TIER, TIERS } from './engine/billing/tiers.js';
import { checkAllowance } from './engine/billing/allowance.js';
import { createPortalSession } from './engine/billing/stripe-customer.js';
import { changePlan } from './engine/billing/plan-change.js';
import { getSpendStatus, addCredits } from './engine/billing/spend-guard.js';
import { setByokKey, deleteByokKey, hasByok } from './engine/billing/byok.js';
import { createCreditCheckout } from './engine/billing/credits.js';
import { EVENT_TYPES } from './engine/usage-recorder.js';
import { createKey, revokeKey, listKeys }    from './engine/key-store.js';
import { isRole }                            from './engine/rbac.js';
import { logVectorCapabilityWarnings }        from './engine/vector-memory.js';
import { getEffectivePolicy, invalidatePolicy, parseRetentionUpdate, RETENTION_BOUNDS } from './engine/retention-policy.js';
import { runRetentionSweep, purgeTenantContent } from './engine/retention.js';
import { startRetentionScheduler }          from './engine/retention-scheduler.js';
import { renderSubprocessorsPage, publicSubprocessors } from './engine/compliance-pages.js';
import { webhookRouter }                     from './engine/webhook-receiver.js';
import { repoRouter, githubAppWebhookRouter } from './engine/repo-routes.js';
import { stripeWebhookRouter }               from './engine/billing/stripe-webhook.js';
import { startAnomalyDetector, anomalyHandler } from './engine/anomaly-detector.js';
import { recordAuditEvent, queryAuditEvents, exportAuditEvents, verifyChain } from './engine/audit-log.js';

// ─── Middleware imports ───────────────────────────────────────────────────────
import { signupTenant, getSignupConfig, logRunnerStartupStatus } from './engine/billing/signup.js';
import {
  requireApiKey, optionalApiKey, assertTenantAccess, allowInactiveTenant,
  requirePermission, requireAdmin, auditActor,
} from './middleware/auth.js';
import { authRouter } from './engine/auth-routes.js';
import { taskRateLimiter } from './middleware/rate-limit.js';

// ─── Dashboard HTML (read once at startup) ────────────────────────────────────
const __filename     = fileURLToPath(import.meta.url);
const __dirname      = dirname(__filename);
const DASHBOARD_HTML = join(__dirname, 'engine', 'dashboard.html');

const dashboardHtml = (() => {
  try {
    return readFileSync(DASHBOARD_HTML, 'utf-8');
  } catch (err) {
    console.warn('[dashboard] Could not read engine/dashboard.html:', err.message);
    return `<!DOCTYPE html><html><body><pre>Dashboard HTML not found at ${DASHBOARD_HTML}.\nRun the server from the project root.</pre></body></html>`;
  }
})();

// ─── Landing + signup pages (read once at startup) ───────────────────────────
const CONTACT_EMAIL = process.env.AEGIS_CONTACT_EMAIL || '';
if (!CONTACT_EMAIL) console.warn('[landing] AEGIS_CONTACT_EMAIL is unset — contact links will be omitted.');
const readLanding = (name) => {
  try {
    const html = readFileSync(join(__dirname, 'landing', name), 'utf-8');
    // {{CONTACT_EMAIL}} appears only inside mailto: hrefs and link text.
    return CONTACT_EMAIL
      ? html.replaceAll('{{CONTACT_EMAIL}}', CONTACT_EMAIL)
      : html.replace(/<a [^>]*href="mailto:\{\{CONTACT_EMAIL\}\}[^"]*"[^>]*>(.*?)<\/a>/gs, '$1').replaceAll('{{CONTACT_EMAIL}}', 'our team');
  } catch (err) {
    console.warn(`[landing] Could not read landing/${name}:`, err.message);
    return null;
  }
};
const landingHtml = readLanding('index.html');
const signupHtml  = readLanding('signup.html');
const termsHtml   = readLanding('terms.html');
const privacyHtml = readLanding('privacy.html');
const dpaHtml      = readLanding('dpa.html');
const securityHtml = readLanding('security.html');
// compliance/subprocessors.json is the single source for the page, the JSON endpoint and the DPA.
const subprocessors = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, 'compliance', 'subprocessors.json'), 'utf-8')); }
  catch (err) { console.warn('[compliance] Could not read compliance/subprocessors.json:', err.message); return null; }
})();
const subprocessorsRaw = readLanding('subprocessors.html');
const subprocessorsHtml = subprocessors && subprocessorsRaw ? renderSubprocessorsPage(subprocessorsRaw, subprocessors) : null;

// ─── App setup ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// /webhooks/* routers parse their own raw body for signature verification;
// the global JSON parser must not consume it first.
const jsonParser = express.json();
app.use((req, res, next) => (req.path.startsWith('/webhooks') ? next() : jsonParser(req, res, next)));

// Trust the first proxy so req.ip resolves correctly behind a load balancer.
app.set('trust proxy', 1);

// ─── Health ───────────────────────────────────────────────────────────────────

/**
 * GET /health
 * Liveness probe — no auth, always 200 while the process is up.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ─── Task submission ──────────────────────────────────────────────────────────

/**
 * POST /task
 * Submit a new task to the multi-agent orchestrator.
 *
 * Body:    { task: string, tenantId?: string, priority?: number }
 * Returns: { workflowId: string, status: 'submitted' }
 *
 * The response shape { workflowId, status: 'submitted' } is what
 * scripts/pipeline.sh checks for — do not change it.
 */
app.post(
  '/task',
  taskRateLimiter,
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  requirePermission('workflow.run'),
  async (req, res) => {
    const { task, tenantId, priority } = req.body ?? {};

    if (!task || typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: '`task` (string) is required.' });
    }

    try {
      const effectiveTenant = tenantId ?? req.resolvedTenantId;
      const workflowId = await runSystem(task.trim(), {
        tenantId: effectiveTenant,
        priority,
      });
      recordAuditEvent(effectiveTenant, {
        ...auditActor(req),
        action: 'workflow.submitted',
        resourceType: 'workflow',
        resourceId: workflowId,
        detail: { task: task.trim().slice(0, 500), priority: priority ?? null },
      }).catch(err => console.error('[audit] workflow.submitted', err));
      res.status(202).json({ workflowId, status: 'submitted' });
    } catch (err) {
      if (err.code === 'TENANT_REPO_NOT_CONNECTED') return res.status(409).json({ error: err.message });
      console.error('[POST /task]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Workflow control ─────────────────────────────────────────────────────────

/**
 * POST /resume
 * Resume a paused workflow.
 *
 * Body: { workflowId: string, tenantId?: string }
 */
app.post(
  '/resume',
  taskRateLimiter,
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  requirePermission('workflow.run'),
  async (req, res) => {
    const { workflowId, tenantId } = req.body ?? {};

    if (!workflowId) {
      return res.status(400).json({ error: '`workflowId` is required.' });
    }

    try {
      await resumeWorkflow(workflowId, tenantId ?? req.resolvedTenantId);
      res.json({ ok: true, workflowId });
    } catch (err) {
      console.error('[POST /resume]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * POST /cancel
 * Cancel a running or paused workflow.
 *
 * Body: { workflowId: string, tenantId?: string, reason?: string }
 */
app.post(
  '/cancel',
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  requirePermission('workflow.run'),
  async (req, res) => {
    const { workflowId, reason, tenantId } = req.body ?? {};

    if (!workflowId) {
      return res.status(400).json({ error: '`workflowId` is required.' });
    }

    try {
      await cancelWorkflow(workflowId, reason ?? 'user request');
      recordAuditEvent(tenantId ?? req.resolvedTenantId ?? 'default', {
        ...auditActor(req),
        action: 'workflow.cancelled',
        resourceType: 'workflow',
        resourceId: workflowId,
        detail: { reason: reason ?? 'user request' },
      }).catch(err => console.error('[audit] workflow.cancelled', err));
      res.json({ ok: true, workflowId });
    } catch (err) {
      console.error('[POST /cancel]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Workflows ────────────────────────────────────────────────────────────────

/**
 * GET /workflows
 * List workflows with optional filters.
 *
 * Query: ?status=<status>&tenantId=<id>&limit=<n>&cursor=<cursor>
 */
app.get(
  '/workflows',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    const { status, tenantId, cursor } = req.query;
    const limit = parseInt(req.query.limit ?? '50', 10);

    try {
      const result = await listWorkflows({
        status:   status   ?? null,
        tenantId: tenantId ?? req.resolvedTenantId ?? null,
        limit,
        cursor:   cursor   ?? '0',
      });
      res.json(result);
    } catch (err) {
      console.error('[GET /workflows]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * GET /workflows/:workflowId
 * Get the status and step details of a single workflow.
 */
app.get('/workflows/:workflowId', requireApiKey, async (req, res) => {
  try {
    const workflow = await getWorkflowStatus(req.params.workflowId);
    if (!workflow) {
      return res.status(404).json({ error: `Workflow ${req.params.workflowId} not found.` });
    }
    res.json(workflow);
  } catch (err) {
    console.error('[GET /workflows/:workflowId]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Workflow templates ────────────────────────────────────────────────────────

/**
 * POST /templates
 * Save a task + validated plan as a reusable template.
 *
 * Body:    { id?: string, task: string, tasks: object[], tenantId?: string }
 * Returns: { id: string }
 */
app.post(
  '/templates',
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  requirePermission('workflow.run'),
  async (req, res) => {
    const { id, task, tasks } = req.body ?? {};
    const tenantId = req.body?.tenantId ?? req.resolvedTenantId;

    if (!task || typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: '`task` (string) is required.' });
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: '`tasks` (non-empty array) is required.' });
    }

    try {
      const plan = validatePlan({ tasks });
      const templateId = await saveTemplate({ id, task: task.trim(), tasks: plan.tasks, tenantId });
      res.status(201).json({ id: templateId });
    } catch (err) {
      console.error('[POST /templates]', err);
      res.status(400).json({ error: err.message });
    }
  },
);

/**
 * GET /templates/:id
 * Fetch a saved template.
 */
app.get(
  '/templates/:id',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    try {
      const template = await getTemplate(req.params.id, req.query.tenantId ?? req.resolvedTenantId ?? null);
      if (!template) {
        return res.status(404).json({ error: `Template ${req.params.id} not found.` });
      }
      res.json(template);
    } catch (err) {
      if (err.code === 'TENANT_MISMATCH') {
        return res.status(403).json({ error: err.message });
      }
      console.error('[GET /templates/:id]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * POST /templates/:id/run
 * Run a saved template directly, skipping the planner.
 *
 * Body:    { tenantId?: string, priority?: number, timeoutMs?: number }
 * Returns: { workflowId: string, status: 'submitted' }
 */
app.post(
  '/templates/:id/run',
  taskRateLimiter,
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  requirePermission('workflow.run'),
  async (req, res) => {
    const tenantId = req.body?.tenantId ?? req.resolvedTenantId;

    try {
      const template = await getTemplate(req.params.id, tenantId ?? null);
      if (!template) {
        return res.status(404).json({ error: `Template ${req.params.id} not found.` });
      }

      const workflowId = await runTemplate(template, {
        tenantId,
        priority:  req.body?.priority,
        timeoutMs: req.body?.timeoutMs,
      });
      res.status(202).json({ workflowId, status: 'submitted' });
    } catch (err) {
      if (err.code === 'TENANT_MISMATCH') {
        return res.status(403).json({ error: err.message });
      }
      console.error('[POST /templates/:id/run]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * GET /templates/:id/versions
 * List archived versions of a template, oldest first (excludes current).
 */
app.get(
  '/templates/:id/versions',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    try {
      const versions = await getTemplateVersions(req.params.id, req.query.tenantId ?? req.resolvedTenantId ?? null);
      res.json({ versions });
    } catch (err) {
      if (err.code === 'TENANT_MISMATCH') {
        return res.status(403).json({ error: err.message });
      }
      console.error('[GET /templates/:id/versions]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * GET /templates/:id/diff?version=N
 * Diff an archived version's tasks against the current template's tasks.
 */
app.get(
  '/templates/:id/diff',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    const tenantId = req.query.tenantId ?? req.resolvedTenantId ?? null;
    const targetVersion = Number(req.query.version);

    if (!Number.isInteger(targetVersion)) {
      return res.status(400).json({ error: '`version` (integer) query param is required.' });
    }

    try {
      const current = await getTemplate(req.params.id, tenantId);
      if (!current) {
        return res.status(404).json({ error: `Template ${req.params.id} not found.` });
      }
      const versions = await getTemplateVersions(req.params.id, tenantId);
      const target = versions.find(v => v.version === targetVersion);
      if (!target) {
        return res.status(404).json({ error: `Version ${targetVersion} not found for template ${req.params.id}.` });
      }
      res.json(diffTemplateTasks(target.tasks, current.tasks));
    } catch (err) {
      if (err.code === 'TENANT_MISMATCH') {
        return res.status(403).json({ error: err.message });
      }
      console.error('[GET /templates/:id/diff]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Step Rewind ──────────────────────────────────────────────────────────────

/**
 * POST /workflows/:workflowId/steps/:stepId/rewind
 * Revert a completed step's git commit and reset it (plus downstream
 * completed steps) back to `pending` so they re-execute on next resume.
 *
 * Body:    { tenantId?: string, reason?: string }
 * Returns: { ok: true, workflowId, stepId, resetSteps: string[], commitHash: string|null }
 *
 * Errors:
 *   400 — step not completed, or workflow not in a rewindable state
 *   404 — workflow or step not found
 *   409 — git revert produced a merge conflict (resolve manually)
 */
app.post(
  '/workflows/:workflowId/steps/:stepId/rewind',
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  requirePermission('workflow.run'),
  async (req, res) => {
    const { workflowId, stepId } = req.params;
    const { tenantId, reason }   = req.body ?? {};
    const tenant = tenantId ?? req.resolvedTenantId;

    try {
      // Acquire worktree lock before reverting so no concurrent step runs
      // while git revert is in progress.
      let worktreeLock = null;
      let cwd          = null;

      try {
        ({ cwd, lock: worktreeLock } = await ensureWorkflowBranch(workflowId, tenant));
      } catch {
        // Worktree not yet created — step never committed; skip git revert.
      }

      let commitHash = null;

      if (cwd) {
        try {
          const result = revertStepCommit(workflowId, stepId, cwd);
          commitHash = result.commitHash;
        } catch (gitErr) {
          return res.status(409).json({
            error: `git revert failed — resolve conflicts manually: ${gitErr.message}`,
          });
        } finally {
          if (worktreeLock) {
            try { await worktreeLock.release(); } catch { /* best-effort */ }
          }
        }
      }

      const result = await rewindStep(workflowId, stepId, { commitHash, reason });

      if (!result.ok) {
        const statusCode = result.reason?.includes('not found') ? 404 : 400;
        return res.status(statusCode).json({ error: result.reason });
      }

      res.json({ ok: true, workflowId, stepId, resetSteps: result.resetSteps, commitHash });

    } catch (err) {
      console.error('[POST /workflows/:workflowId/steps/:stepId/rewind]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * GET /workflows/:workflowId/rewind-history
 * Return the rewind audit trail for a workflow, newest first.
 */
app.get('/workflows/:workflowId/rewind-history', requireApiKey, async (req, res) => {
  try {
    const history = await getRewindHistory(req.params.workflowId);
    res.json({ history });
  } catch (err) {
    console.error('[GET /workflows/:workflowId/rewind-history]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Concurrency ──────────────────────────────────────────────────────────────

/**
 * GET /concurrency/:workflowId
 * Return live concurrency slot status for a workflow.
 *
 * Query: ?priority=<0-10>  (default: 5 = NORMAL)
 */
app.get('/concurrency/:workflowId', requireApiKey, async (req, res) => {
  const priority = parseInt(req.query.priority ?? '5', 10);
  try {
    const status = await slotStatus(req.params.workflowId, priority);
    res.json(status);
  } catch (err) {
    console.error('[GET /concurrency/:workflowId]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

/**
 * GET /jobs
 * List jobs for the authenticated tenant.
 *
 * Query: ?tenantId=<id>&limit=<n>
 */
app.get(
  '/jobs',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    const tenantId = req.query.tenantId ?? req.resolvedTenantId;
    const limit    = parseInt(req.query.limit ?? '200', 10);

    if (!assertTenantAccess(req, tenantId, res)) return;

    try {
      const jobs = await listJobs(tenantId, { limit });
      res.json({ jobs });
    } catch (err) {
      console.error('[GET /jobs]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

/**
 * GET /jobs/:jobId
 * Get a single job record.
 *
 * Query: ?tenantId=<id>
 */
app.get(
  '/jobs/:jobId',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    const tenantId = req.query.tenantId ?? req.resolvedTenantId;
    const { jobId } = req.params;

    if (!assertTenantAccess(req, tenantId, res)) return;

    try {
      const job = await getJob(jobId, tenantId);
      if (!job) return res.status(404).json({ error: `Job ${jobId} not found.` });
      res.json(job);
    } catch (err) {
      console.error('[GET /jobs/:jobId]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Dead-letter queue ──────────────────────────────────────────────────────

/**
 * GET /dlq
 * List raw dead-letter entries for the authenticated tenant.
 * Audit trail — most entries are drained by the DLQ worker within seconds
 * (see workers/dlq-worker.js).
 *
 * Query: ?tenantId=<id>&limit=<n>
 */
app.get(
  '/dlq',
  (req, res, next) => requireApiKey(req, res, next, req.query.tenantId),
  async (req, res) => {
    const tenantId = req.query.tenantId ?? req.resolvedTenantId;
    const limit    = parseInt(req.query.limit ?? '100', 10);

    if (!assertTenantAccess(req, tenantId, res)) return;

    try {
      const dlq  = getDeadLetterQueue(tenantId);
      const jobs = await dlq.getJobs(['waiting', 'failed'], 0, Math.max(limit - 1, 0));
      const items = await Promise.all(jobs.map(async (job) => ({
        id: job.id,
        state: await job.getState(),
        data: job.data,
        failedReason: job.failedReason,
        addedAt: job.timestamp,
      })));
      res.json({ items });
    } catch (err) {
      console.error('[GET /dlq]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Traces ───────────────────────────────────────────────────────────────────

/**
 * GET /traces
 * List recent workflow traces.
 *
 * Query: ?limit=<n>
 */
app.get('/traces', requireApiKey, async (req, res) => {
  const limit = parseInt(req.query.limit ?? '100', 10);

  try {
    const traces = await listTraces(limit);
    res.json({ traces });
  } catch (err) {
    console.error('[GET /traces]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /traces/:traceId
 * Get a single workflow trace with all its spans.
 */
app.get('/traces/:traceId', requireApiKey, async (req, res) => {
  try {
    const trace = await getTrace(req.params.traceId);
    if (!trace) {
      return res.status(404).json({ error: `Trace ${req.params.traceId} not found.` });
    }
    res.json(trace);
  } catch (err) {
    console.error('[GET /traces/:traceId]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Review queue ─────────────────────────────────────────────────────────────

/**
 * GET /review-queue
 * Return pending (or filtered) human-review items.
 *
 * Query: ?status=pending|approved|rejected&limit=<n>
 */
app.get('/review-queue', requireApiKey, async (req, res) => {
  const status = req.query.status ?? 'pending';
  const limit  = parseInt(req.query.limit ?? '50', 10);

  try {
    const items = await getReviewQueue({ status, limit });
    res.json({ items });
  } catch (err) {
    console.error('[GET /review-queue]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /review-queue/resolve
 * Resolve a queued human-review item.
 *
 * Body: { workflowId, stepId, resolution: 'retrying'|'skip'|'escalate', note?: string, tenantId?: string }
 *
 *   retrying  — reset the step and re-queue it at CRITICAL priority so the
 *               agent-worker picks it up immediately for a fresh attempt.
 *
 *   skip      — mark the step as skipped and remove it from the review queue;
 *               the workflow continues with any remaining steps.
 *
 *   escalate  — cancel the workflow entirely and persist the human note so
 *               operators have a permanent record of why it was escalated.
 */
app.post('/review-queue/resolve', requireApiKey, requirePermission('review.resolve'), async (req, res) => {
  const { workflowId, stepId, resolution, note, tenantId } = req.body ?? {};

  if (!workflowId || !stepId || !resolution) {
    return res.status(400).json({
      error: '`workflowId`, `stepId`, and `resolution` are required.',
    });
  }

  if (!['retrying', 'skip', 'escalate'].includes(resolution)) {
    return res.status(400).json({
      error: '`resolution` must be "retrying", "skip", or "escalate".',
    });
  }

  try {
    // 1. Persist the resolution in the review record regardless of action taken.
    await resolveReview(workflowId, stepId, resolution, note ?? '');

    const effectiveTenant = tenantId ?? req.resolvedTenantId ?? 'default';

    if (resolution === 'retrying') {
      // Reset attempt counter and re-queue into the CRITICAL lane.
      const resetStep = await resetStepForRetry(workflowId, stepId);
      if (!resetStep) {
        return res.status(404).json({ error: `Step "${stepId}" not found in workflow "${workflowId}".` });
      }
      await addStep(workflowId, resetStep, Priority.CRITICAL, effectiveTenant);

    } else if (resolution === 'skip') {
      // Mark the step skipped so dependency-aware scheduling can proceed.
      await updateStep(workflowId, stepId, 'skipped');

    } else if (resolution === 'escalate') {
      // Cancel the workflow; the review record already carries the human note.
      await cancelWorkflow(workflowId, `escalated by operator: ${note ?? '(no note)'}`);
    }

    recordAuditEvent(effectiveTenant, {
      ...auditActor(req),
      action: 'review.resolved',
      resourceType: 'workflowStep',
      resourceId: `${workflowId}/${stepId}`,
      detail: { resolution, note: note ?? '' },
    }).catch(err => console.error('[audit] review.resolved', err));

    res.json({ ok: true, workflowId, stepId, resolution });
  } catch (err) {
    console.error('[POST /review-queue/resolve]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Metrics ──────────────────────────────────────────────────────────────────

/**
 * GET /metrics
 * Prometheus text-format export.
 * Intended for Prometheus / Grafana Agent scraping.
 */
app.get('/metrics', optionalApiKey, async (_req, res) => {
  try {
    const text = await renderPrometheus();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(text);
  } catch (err) {
    console.error('[GET /metrics]', err);
    res.status(500).send(`# ERROR: ${err.message}\n`);
  }
});

/**
 * GET /metrics/json
 * OTEL-compatible JSON export.
 * Consumed by the dashboard as a fallback when /api/metrics is unavailable.
 */
app.get('/metrics/json', optionalApiKey, async (_req, res) => {
  try {
    const data = await renderOtel();
    res.json(data);
  } catch (err) {
    console.error('[GET /metrics/json]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/metrics
 * Internal structured metrics object consumed by the dashboard.
 * Returns all-time counters, windowed rollups, latency percentiles,
 * per-agent stats, and recent steps.
 */
app.get('/api/metrics', requireApiKey, async (_req, res) => {
  try {
    const data = await getMetrics();
    res.json(data);
  } catch (err) {
    console.error('[GET /api/metrics]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

/**
 * GET /dashboard
 * Full observability UI — self-contained single-page HTML app.
 */
app.get('/dashboard', requireApiKey, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(dashboardHtml);
});

// ─── Anomaly detection ────────────────────────────────────────────────────────

/**
 * GET /anomalies
 * Return the most recent anomaly alerts detected by the in-process detector.
 * Newest first. Optional query param: ?limit=<n> (default 50, max 200).
 *
 * Response: { anomalies: [...], count: number }
 */
app.get('/anomalies', requireApiKey, anomalyHandler);

// ─── Self-serve signup ─────────────────────────────────────────────────────────
/**
 * POST /signup
 * Unauthenticated. Provisions a new tenant end-to-end: Stripe customer +
 * subscription (tier base price + metered items), tenant registration,
 * quota, billing config, and a first API key.
 *
 * Body:    { email: string, tenantId: string, label?: string, tier?: 'starter'|'pro'|'enterprise' }
 * Returns: { tenantId, tier, apiKey, keyId, stripeCustomerId, stripeSubscriptionId, status, clientSecret }
 *
 * The account is 'pending' (API calls return 402) until the first payment is
 * confirmed via clientSecret and Stripe's invoice.paid webhook activates it.
 *
 * apiKey is returned ONCE — same rule as POST /tenants/:id/keys.
 * If tenant provisioning fails after the Stripe subscription is created, the
 * subscription is cancelled so a failed signup never leaves a live orphan.
 */
app.post('/signup', taskRateLimiter, async (req, res) => {
  const { status, body } = await signupTenant(req.body);
  res.status(status).json(body);
});

/**
 * GET /signup/config
 * Unauthenticated. Returns the Stripe publishable key (public by design) and
 * the self-serve tiers with their base prices (read from Stripe, cached 5 min) so the signup page can mount Stripe.js. 503 when
 * STRIPE_PUBLISHABLE_KEY is unset.
 */
app.get('/signup/config', async (_req, res) => {
  const { status, body } = await getSignupConfig();
  res.status(status).set('Cache-Control', 'no-store').json(body);
});

/**
 * GET /  and  GET /get-started
 * Unauthenticated static pages: the marketing landing page and the self-serve
 * signup page (calls POST /signup, then confirms payment with Stripe.js).
 * Served from the same origin as the API so no CORS configuration is needed.
 */
app.get('/', (_req, res, next) => (landingHtml ? res.type('html').send(landingHtml) : next()));
app.get('/get-started', (_req, res, next) => (signupHtml ? res.type('html').send(signupHtml) : next()));
app.get('/terms', (_req, res, next) => (termsHtml ? res.type('html').send(termsHtml) : next()));
app.get('/privacy', (_req, res, next) => (privacyHtml ? res.type('html').send(privacyHtml) : next()));
app.get('/dpa', (_req, res, next) => (dpaHtml ? res.type('html').send(dpaHtml) : next()));
app.get('/security', (_req, res, next) => (securityHtml ? res.type('html').send(securityHtml) : next()));
app.get('/subprocessors', (_req, res, next) => (subprocessorsHtml ? res.type('html').send(subprocessorsHtml) : next()));
app.get('/subprocessors.json', (_req, res, next) => (subprocessors ? res.json(publicSubprocessors(subprocessors)) : next()));

/**
 * POST /billing/portal
 * Returns a Stripe billing-portal URL for the calling tenant (update card,
 * pay an open invoice, cancel). Reachable while pending/suspended — paying
 * fires invoice.paid, which re-activates the tenant.
 *
 * Returns: { url: string }
 */
app.post('/billing/portal', allowInactiveTenant, requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  try {
    const customerId = await getStripeCustomerId(req.resolvedTenantId);
    if (!customerId) {
      return res.status(404).json({ error: 'No Stripe customer on file for this tenant.' });
    }
    res.json({ url: await createPortalSession(customerId) });
  } catch (err) {
    console.error('[POST /billing/portal]', err);
    res.status(502).json({ error: `Billing portal unavailable: ${err.message}` });
  }
});

/**
 * POST /billing/plan
 * Body: { tier: 'free' | 'starter' | 'pro', email?: string }
 *
 * Self-serve plan change for the calling tenant (see billing/plan-change.js for
 * the matrix). Deliberately NOT allowInactiveTenant: a pending or suspended
 * tenant must fix payment through POST /billing/portal first, not change plan.
 * Rate-limited because free → paid creates a Stripe subscription.
 *
 * Returns: { tenantId, currentTier, targetTier, effective, effectiveAt, clientSecret? }
 */
app.post('/billing/plan', taskRateLimiter, requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  const { status, body } = await changePlan({
    tenantId: req.resolvedTenantId,
    tier: req.body?.tier,
    email: req.body?.email,
  });
  res.status(status).json(body);
});

// ─── Tenant management ────────────────────────────────────────────────────────
/**
 * GET /tenants
 * List all registered tenants.
 */
app.get('/tenants', requireApiKey, async (_req, res) => {
  try {
    const tenants = await listTenants();
    res.json({ tenants });
  } catch (err) {
    console.error('[GET /tenants]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tenants
 * Register a new tenant.
 *
 * Body: { tenantId: string, label?: string, tier?: 'starter'|'pro'|'enterprise' }
 * Unknown/omitted tier falls back to DEFAULT_TIER. Sets tenant-quota.js
 * limits from the tier's `quota` block at creation time.
 */
app.post('/tenants', requireApiKey, async (req, res) => {
  const { tenantId, label, tier } = req.body ?? {};

  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    return res.status(400).json({ error: '`tenantId` (string) is required.' });
  }
  if (tier !== undefined && !TIERS[tier]) {
    return res.status(400).json({ error: `Unknown tier "${tier}". Valid: ${Object.keys(TIERS).join(', ')}.` });
  }

  try {
    const id = tenantId.trim();
    const resolvedTier = tier ?? DEFAULT_TIER;
    const tenant = await registerTenant(id, { label });
    await setTier(id, resolvedTier);
    await setQuota(id, getTierConfig(resolvedTier).quota);
    res.status(201).json({ ...tenant, tier: resolvedTier });
  } catch (err) {
    console.error('[POST /tenants]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /tenants/:id
 * Get metadata for a single tenant.
 */
app.get('/tenants/:id', requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) {
      return res.status(404).json({ error: `Tenant "${req.params.id}" not found.` });
    }
    res.json(tenant);
  } catch (err) {
    console.error('[GET /tenants/:id]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /tenants/:id/billing
 * Current tier and this billing period's usage vs. included allowance,
 * per metered dimension. Overage is informational — it's already flowing to
 * Stripe via billing/stripe-reporter.js regardless of this endpoint.
 */
app.get('/tenants/:id/billing', allowInactiveTenant, requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  try {
    const tenant = await getTenant(req.params.id);
    if (!tenant) {
      return res.status(404).json({ error: `Tenant "${req.params.id}" not found.` });
    }
    const usage = await Promise.all(
      Object.values(EVENT_TYPES).map((eventType) => checkAllowance(req.params.id, eventType))
    );
    res.json({ tenantId: req.params.id, tier: usage[0]?.tier ?? DEFAULT_TIER, usage });
  } catch (err) {
    console.error('[GET /tenants/:id/billing]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Spend control & BYOK ─────────────────────────────────────────────────────

/** GET /tenants/:id/spend — cap/credit state for this month. Reachable while suspended. */
app.get('/tenants/:id/spend', allowInactiveTenant, requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    res.json({ ...(await getSpendStatus(req.params.id)), byok: await hasByok(req.params.id) });
  } catch (err) {
    console.error('[GET /tenants/:id/spend]', err);
    res.status(500).json({ error: err.message });
  }
});

/** PUT /tenants/:id/spend (admin) — body { mode?: 'capped'|'prepaid', capUsd?: number } */
app.put('/tenants/:id/spend', requireAdmin, async (req, res) => {
  try {
    await setSpendConfig(req.params.id, { mode: req.body?.mode, capUsd: req.body?.capUsd });
    res.json(await getSpendStatus(req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /tenants/:id/credits (admin) — manual grant. Body { usd, ref } (ref = idempotency key). */
app.post('/tenants/:id/credits', requireAdmin, async (req, res) => {
  try {
    const { usd, ref } = req.body ?? {};
    res.json(await addCredits(req.params.id, usd, `manual:${ref}`));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** POST /tenants/:id/credits/checkout — tenant buys credits. Body { usd }. Reachable while suspended. */
app.post('/tenants/:id/credits/checkout', allowInactiveTenant, requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    res.json(await createCreditCheckout(req.params.id, Number(req.body?.usd)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** PUT /tenants/:id/byok — enterprise: store own Anthropic key. Body { apiKey }. Never echoed back. */
app.put('/tenants/:id/byok', requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    await setByokKey(req.params.id, req.body?.apiKey);
    res.json({ byok: true });
  } catch (err) {
    const status = err.code === 'BYOK_NOT_ENTITLED' ? 403 : err.code === 'BYOK_INVALID_KEY' ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

/** DELETE /tenants/:id/byok — revert to the platform key (platform spend cap applies again). */
app.delete('/tenants/:id/byok', requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    await deleteByokKey(req.params.id);
    res.json({ byok: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Data retention, zero-retention mode, deletion ────────────────────────────

/** GET /tenants/:id/retention — effective policy (overrides merged over platform defaults). */
app.get('/tenants/:id/retention', requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  try {
    invalidatePolicy(req.params.id);
    const { jobsDays, workflowsDays, memoryDays, zeroRetention, overrides } = await getEffectivePolicy(req.params.id);
    res.json({ jobsDays, workflowsDays, memoryDays, zeroRetention, overrides, bounds: RETENTION_BOUNDS });
  } catch (err) {
    console.error('[GET /tenants/:id/retention]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /tenants/:id/retention — body: any of { jobsDays, workflowsDays, memoryDays, zeroRetention }.
 * Days are 1–365 (null resets to the platform default). Enabling zero-retention
 * sweeps the tenant immediately so existing content is scrubbed.
 */
app.put('/tenants/:id/retention', requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  const { updates, error } = parseRetentionUpdate(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const before = await getEffectivePolicy(req.params.id);
    await setRetentionConfig(req.params.id, updates);
    invalidatePolicy(req.params.id);
    const after = await getEffectivePolicy(req.params.id);

    await recordAuditEvent(req.params.id, {
      ...auditActor(req),
      action: 'retention.updated',
      resourceType: 'tenant',
      resourceId: req.params.id,
      detail: { updates, previous: { jobsDays: before.jobsDays, workflowsDays: before.workflowsDays, memoryDays: before.memoryDays, zeroRetention: before.zeroRetention } },
    }).catch((err) => console.error('[audit] retention.updated', err));

    let sweep = null;
    if (updates.zeroRetention === true && !before.zeroRetention) {
      try { sweep = (await runRetentionSweep({ tenantIds: [req.params.id] })).tenants[req.params.id] ?? null; }
      catch (err) { console.error('[retention] immediate sweep failed (daily sweep will retry):', err.message); }
    }
    res.json({ jobsDays: after.jobsDays, workflowsDays: after.workflowsDays, memoryDays: after.memoryDays, zeroRetention: after.zeroRetention, overrides: after.overrides, sweep });
  } catch (err) {
    console.error('[PUT /tenants/:id/retention]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tenants/:id/data-deletion — body { confirm: "<tenantId>" }.
 * Deletes finished-workflow, job and vector-memory content (DPA §8). Active
 * workflows are skipped (cancel, then call again). The audit log, billing
 * records, API keys and repo clone are NOT removed — see docs "Compliance".
 */
app.post('/tenants/:id/data-deletion', requireApiKey, requirePermission('tenant.admin'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;
  if (req.body?.confirm !== req.params.id) {
    return res.status(400).json({ error: `Send {"confirm":"${req.params.id}"} to confirm deletion of this workspace's content.` });
  }
  try {
    const result = await purgeTenantContent(req.params.id);
    await recordAuditEvent(req.params.id, {
      ...auditActor(req),
      action: 'data.deleted',
      resourceType: 'tenant',
      resourceId: req.params.id,
      detail: result,
    }).catch((err) => console.error('[audit] data.deleted', err));
    res.json(result);
  } catch (err) {
    console.error('[POST /tenants/:id/data-deletion]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API key management ───────────────────────────────────────────────────────

/**
 * GET /tenants/:id/keys
 * List API keys for a tenant (hashes only — raw keys are never stored).
 */
app.get('/tenants/:id/keys', requireApiKey, requirePermission('key.manage'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  try {
    const keys = await listKeys(req.params.id);
    res.json({ keys });
  } catch (err) {
    console.error('[GET /tenants/:id/keys]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /tenants/:id/keys
 * Create a new API key for a tenant.
 *
 * Body:    { label?: string, expiresAt?: number, role?: 'viewer'|'member'|'admin' (default 'member') }
 * Returns: { keyId, rawKey, tenantId, label, createdAt, expiresAt }
 *
 * rawKey is returned ONCE and never stored — save it immediately.
 */
app.post('/tenants/:id/keys', requireApiKey, requirePermission('key.manage'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  // Least privilege by default: a key is `member` unless the caller asks for more.
  const { label, expiresAt, role = 'member' } = req.body ?? {};
  if (!isRole(role)) return res.status(400).json({ error: '`role` must be viewer, member or admin.' });

  try {
    const result = await createKey(req.params.id, {
      label, expiresAt: expiresAt ?? null, role,
      createdBy: { type: req.actor.type, id: req.actor.id, ...(req.actor.email && { email: req.actor.email }) },
    });
    recordAuditEvent(req.params.id, {
      ...auditActor(req),
      action: 'key.created',
      resourceType: 'apiKey',
      resourceId: result.keyId,
      detail: { label: result.record.label, role: result.record.role, expiresAt: result.record.expiresAt },
    }).catch(err => console.error('[audit] key.created', err));
    res.status(201).json(result);
  } catch (err) {
    console.error('[POST /tenants/:id/keys]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /tenants/:id/keys/:keyId
 * Revoke an API key immediately (no restart required).
 */
app.delete('/tenants/:id/keys/:keyId', requireApiKey, requirePermission('key.manage'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  try {
    const revoked = await revokeKey(req.params.id, req.params.keyId);
    if (revoked) {
      recordAuditEvent(req.params.id, {
        ...auditActor(req),
        action: 'key.revoked',
        resourceType: 'apiKey',
        resourceId: req.params.keyId,
        detail: {},
      }).catch(err => console.error('[audit] key.revoked', err));
    }
    res.json({ ok: true, keyId: req.params.keyId });
  } catch (err) {
    console.error('[DELETE /tenants/:id/keys/:keyId]', err);
    res.status(500).json({ error: err.message });
  }
});


// ─── Audit log / compliance export ─────────────────────────────────────────────

/**
 * GET /tenants/:id/audit-log
 * Query the tamper-evident compliance audit trail for a tenant.
 *
 * Query: ?from=<ms>&to=<ms>&action=<action>&resourceType=<type>&limit=<n>
 * Returns: { events: AuditEvent[], chainValid: boolean }
 */
app.get('/tenants/:id/audit-log', requireApiKey, requirePermission('audit.read'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  const { from, to, action, resourceType, limit } = req.query;

  try {
    const events = await queryAuditEvents(req.params.id, {
      from:         from ? Number(from) : undefined,
      to:           to   ? Number(to)   : undefined,
      action:       action ?? null,
      resourceType: resourceType ?? null,
      limit:        limit ? Number(limit) : undefined,
    });
    res.json({ events, chainValid: verifyChain(events).ok });
  } catch (err) {
    console.error('[GET /tenants/:id/audit-log]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /tenants/:id/audit-log/export
 * Export the full compliance audit trail as JSON or CSV, with chain
 * integrity verified server-side (chainValid in the JSON payload / a
 * `X-Audit-Chain-Valid` header on CSV, since CSV has no metadata envelope).
 *
 * Query: ?from=<ms>&to=<ms>&format=json|csv
 */
app.get('/tenants/:id/audit-log/export', requireApiKey, requirePermission('audit.read'), async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  const { from, to, format } = req.query;
  const fmt = format === 'csv' ? 'csv' : 'json';

  try {
    const result = await exportAuditEvents(req.params.id, {
      from: from ? Number(from) : undefined,
      to:   to   ? Number(to)   : undefined,
      format: fmt,
    });
    res.set('Content-Type', result.contentType);
    if (fmt === 'csv') {
      res.set('X-Audit-Chain-Valid', String(result.chainValid));
      res.set('Content-Disposition', `attachment; filename="audit-${req.params.id}-${Date.now()}.csv"`);
    }
    res.send(result.body);
  } catch (err) {
    console.error('[GET /tenants/:id/audit-log/export]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE live-push stream ─────────────────────────────────────────────────────

/**
 * GET /events
 * Server-Sent Events stream — pushes live metrics and recent workflow updates
 * to the dashboard without polling.  Replaces the 15 s setInterval in the UI.
 *
 * Events emitted:
 *   metrics   — structured metrics snapshot (same shape as GET /api/metrics)
 *   workflows — recent workflow list (up to 20, newest first)
 *   ping      — keepalive comment every 25 s so proxies don't close the socket
 *
 * Auth: same API key required as all other endpoints.
 * The dashboard supplies it via the X-API-Key header set in apiFetch().
 * When AEGIS_SKIP_AUTH=1 (dev mode), the key check is bypassed.
 *
 * The connection is cleaned up automatically on client disconnect.
 */
app.get('/events', requireApiKey, (req, res) => {
  // SSE headers — disable all buffering so events reach the browser immediately
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: disable proxy buffering
  res.flushHeaders();

  /** Write a named SSE event with a JSON payload. */
  function send(event, data) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client already gone */ }
  }

  /** Push one full snapshot to the client. */
  async function push() {
    try {
      const [metrics, { workflows }] = await Promise.all([
        getMetrics(),
        listWorkflows({ limit: 20 }),
      ]);
      send('metrics',   metrics);
      send('workflows', workflows);
    } catch (err) {
      // Non-fatal: log and skip this tick; next tick will retry
      console.warn('[SSE /events] push error:', err.message);
    }
  }

  // Push immediately so the dashboard has data before the first interval fires
  push();

  // Push a live snapshot every 4 seconds
  const pushInterval = setInterval(push, 4_000);

  // Keepalive comment every 25 s — prevents nginx / load-balancers from
  // closing idle connections before actual data arrives
  const pingInterval = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* client gone */ }
  }, 25_000);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(pushInterval);
    clearInterval(pingInterval);
  });
});

// ─── Inbound webhooks (Stripe → log "partner paid") ──────────────────────────
    //
    // POST /webhooks/stripe — logs a flag line on checkout/invoice payment
    // events. No tenant provisioning, no metering — see stripe-webhook.js.
    //
    // Mounted BEFORE webhookRouter on purpose: webhookRouter's body middleware
    // parses every /webhooks/* body into an object, which would make Stripe's
    // signature check (it needs the raw bytes) fail with 401.
    app.use('/webhooks', stripeWebhookRouter);
    app.use('/webhooks', githubAppWebhookRouter); // raw body — must precede webhookRouter

// ─── Inbound webhooks (GitHub / GitLab → trigger workflows) ──────────────────
    //
    // POST /webhooks/github  — receives GitHub push + pull_request events
    // POST /webhooks/gitlab  — receives GitLab Push Hook + Merge Request Hook events
    //
    // No API-key auth: webhook requests are authenticated via HMAC signature
    // (GitHub) or a shared secret token (GitLab) inside webhookRouter itself.
    app.use('/webhooks', webhookRouter);

app.use(authRouter);
app.use(repoRouter);

// ─── React dashboard (dashboard/dist, built with `npm run build:dashboard`) ───
// Mounted under /app because the SPA's own routes (/workflows, /tenants, …)
// collide with API paths. Static assets are public; every data call the SPA
// makes is authenticated by the API as usual.
const DASHBOARD_DIST = join(__dirname, 'dashboard', 'dist');
if (existsSync(join(DASHBOARD_DIST, 'index.html'))) {
  app.use('/app', express.static(DASHBOARD_DIST, { index: false }));
  app.get(['/app', '/app/*'], (req, res, next) => {
    if (/\.[a-z0-9]+$/i.test(req.path)) return next(); // missing asset → 404, not index.html
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(DASHBOARD_DIST, 'index.html'));
  });
} else {
  console.warn('[dashboard] dashboard/dist not found — /app is disabled. Run `npm run build:dashboard`.');
}

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  // Seed tenants from AEGIS_TENANTS env var before accepting traffic.
  await seedTenantsFromEnv();

  // Probe and log vector memory capability warnings at startup so operators
  // know immediately if OPENAI_API_KEY or Redis Stack is missing.
  await logVectorCapabilityWarnings();

  // Warn early if no isolated sandbox runner is configured (DOCKER_HOST).
  logRunnerStartupStatus();

  // Start in-process anomaly detection loop.
  // Evaluates metric rules every ANOMALY_INTERVAL_MS (default 60 s) and fires
  // alerts to stderr + AEGIS_ALERT_WEBHOOK when thresholds are sustained.
  startAnomalyDetector();

  // In-process safety net for retention (the daily cron is still recommended).
  startRetentionScheduler();

  app.listen(PORT, () => {
    console.info(`[server] Aegis API listening on port ${PORT}`);
    console.info(`[server] Dashboard → http://localhost:${PORT}/dashboard`);
    if (existsSync(join(DASHBOARD_DIST, 'index.html'))) console.info(`[server] Usage & billing UI → http://localhost:${PORT}/app/`);
  });
}

start().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
