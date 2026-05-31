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
 *   GET  /health                  Liveness check (no auth)
 *   POST /task                    Submit a new task
 *   POST /resume                  Resume a paused workflow
 *   POST /cancel                  Cancel a running workflow
 *   GET  /jobs                    List jobs (tenant-scoped)
 *   GET  /jobs/:jobId             Get a single job
 *   GET  /traces                  List workflow traces
 *   GET  /traces/:traceId         Get a single trace
 *   GET  /workflows               List workflows (with optional filters)
 *   GET  /workflows/:workflowId   Get workflow status
 *   GET  /review-queue            Pending human-review items
 *   POST /review-queue/resolve    Resolve a review item
 *   GET  /metrics                 Prometheus text export
 *   GET  /metrics/json            OTEL-compatible JSON export
 *   GET  /api/metrics             Structured metrics (dashboard internal)
 *   GET  /dashboard               Observability UI (single-page HTML)
 *   GET  /tenants                 List registered tenants
 *   POST /tenants                 Register a new tenant
 *   GET  /tenants/:id             Get tenant metadata
 *   GET  /tenants/:id/keys        List API keys for a tenant
 *   POST /tenants/:id/keys        Create an API key for a tenant
 *   DELETE /tenants/:id/keys/:kid Revoke an API key
 */

import 'dotenv/config';
import { readFileSync }            from 'fs';
import { fileURLToPath }           from 'url';
import { dirname, join }           from 'path';
import express                     from 'express';

// ─── Engine imports ───────────────────────────────────────────────────────────
import { runSystem }               from './engine/orchestrator.js';
import { getJob, listJobs }        from './engine/job-store.js';
import { getTrace, listTraces }    from './engine/tracer.js';
import { getMetrics, renderPrometheus, renderOtel } from './engine/metrics.js';
import {
  getWorkflowStatus,
  listWorkflows,
  resumeWorkflow,
  cancelWorkflow,
  getReviewQueue,
  resolveReview,
  rewindStep,
  getRewindHistory,
} from './engine/workflow-store.js';
import { revertStepCommit, ensureWorkflowBranch } from './engine/git.js';
import { acquireLock, releaseLock } from './engine/lock.js';
import {
  listTenants,
  getTenant,
  registerTenant,
  seedTenantsFromEnv,
} from './engine/tenant-registry.js';
import {
  createKey,
  revokeKey,
  listKeys,
} from './engine/key-store.js';

// ─── Middleware imports ───────────────────────────────────────────────────────
import {
  requireApiKey,
  optionalApiKey,
  assertTenantAccess,
} from './middleware/auth.js';
import { taskRateLimiter }         from './middleware/rate-limit.js';

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

// ─── App setup ────────────────────────────────────────────────────────────────
const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(express.json());

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
 * Body: { task: string, tenantId?: string, priority?: number }
 */
app.post(
  '/task',
  taskRateLimiter,
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  async (req, res) => {
    const { task, tenantId, priority } = req.body ?? {};

    if (!task || typeof task !== 'string' || !task.trim()) {
      return res.status(400).json({ error: '`task` (string) is required.' });
    }

    try {
      const result = await runSystem(task.trim(), {
        tenantId: tenantId ?? req.resolvedTenantId,
        priority,
      });
      res.status(202).json(result);
    } catch (err) {
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
  async (req, res) => {
    const { workflowId, tenantId, reason } = req.body ?? {};

    if (!workflowId) {
      return res.status(400).json({ error: '`workflowId` is required.' });
    }

    try {
      await cancelWorkflow(
        workflowId,
        reason ?? 'user request',
      );
      res.json({ ok: true, workflowId });
    } catch (err) {
      console.error('[POST /cancel]', err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Step Rewind ──────────────────────────────────────────────────────────────

/**
 * POST /workflows/:workflowId/steps/:stepId/rewind
 * Revert a completed step's git commit and reset it (plus any downstream
 * completed steps) back to `pending` so they are re-executed on resume.
 *
 * Body: { tenantId?: string, reason?: string }
 *
 * Returns:
 *   { ok: true, workflowId, stepId, resetSteps: string[], commitHash: string|null }
 *
 * Errors:
 *   400 — step not completed, or workflow not in a rewindable state
 *   404 — workflow or step not found
 *   409 — git revert produced a merge conflict (resolve manually)
 */
app.post(
  '/workflows/:workflowId/steps/:stepId/rewind',
  (req, res, next) => requireApiKey(req, res, next, req.body?.tenantId),
  async (req, res) => {
    const { workflowId, stepId } = req.params;
    const { tenantId, reason }   = req.body ?? {};
    const tenant = tenantId ?? req.resolvedTenantId;

    try {
      // ── Acquire the worktree lock so no concurrent step runs during the revert ─
      let worktreeLock = null;
      let cwd          = null;

      try {
        ({ cwd, lock: worktreeLock } = await ensureWorkflowBranch(workflowId, tenant));
      } catch {
        // Worktree not yet created — step was never committed; skip git revert.
      }

      let commitHash = null;

      if (cwd) {
        try {
          const result = revertStepCommit(workflowId, stepId, cwd);
          commitHash = result.commitHash;
          // result.reverted === false means the commit was not found (e.g. the
          // step failed before writing).  We still reset the step state below.
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

      // ── Reset step state in Redis ──────────────────────────────────────────
      const result = await rewindStep(workflowId, stepId, { commitHash, reason });

      if (!result.ok) {
        const statusCode = result.reason?.includes('not found') ? 404 : 400;
        return res.status(statusCode).json({ error: result.reason });
      }

      res.json({
        ok:         true,
        workflowId,
        stepId,
        resetSteps: result.resetSteps,
        commitHash,
      });

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
 * Approve or reject a queued review item.
 *
 * Body: { workflowId, stepId, resolution: 'approved'|'rejected', note?: string }
 */
app.post('/review-queue/resolve', requireApiKey, async (req, res) => {
  const { workflowId, stepId, resolution, note } = req.body ?? {};

  if (!workflowId || !stepId || !resolution) {
    return res.status(400).json({
      error: '`workflowId`, `stepId`, and `resolution` are required.',
    });
  }

  if (!['approved', 'rejected'].includes(resolution)) {
    return res.status(400).json({
      error: '`resolution` must be "approved" or "rejected".',
    });
  }

  try {
    await resolveReview(workflowId, stepId, resolution, note ?? '');
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
 *
 * Auth: requireApiKey (operators should use a read-only key for browser access).
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
 * Full observability UI — self-contained single-page HTML.
 * Auth: requireApiKey.
 */
app.get('/dashboard', requireApiKey, (_req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(dashboardHtml);
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
 * Body: { tenantId: string, label?: string }
 */
app.post('/tenants', requireApiKey, async (req, res) => {
  const { tenantId, label } = req.body ?? {};

  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    return res.status(400).json({ error: '`tenantId` (string) is required.' });
  }

  try {
    const tenant = await registerTenant(tenantId.trim(), { label });
    res.status(201).json(tenant);
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

// ─── API key management ───────────────────────────────────────────────────────

/**
 * GET /tenants/:id/keys
 * List API keys for a tenant (hashes only — raw keys are never stored).
 */
app.get('/tenants/:id/keys', requireApiKey, async (req, res) => {
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
 * Body: { label?: string, expiresAt?: number }
 * Returns: { keyId, rawKey, tenantId, label, createdAt, expiresAt }
 *
 * rawKey is returned ONCE and never stored — save it immediately.
 */
app.post('/tenants/:id/keys', requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  const { label, expiresAt } = req.body ?? {};

  try {
    const result = await createKey(req.params.id, { label, expiresAt: expiresAt ?? null });
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
app.delete('/tenants/:id/keys/:keyId', requireApiKey, async (req, res) => {
  if (!assertTenantAccess(req, req.params.id, res)) return;

  try {
    await revokeKey(req.params.id, req.params.keyId);
    res.json({ ok: true, keyId: req.params.keyId });
  } catch (err) {
    console.error('[DELETE /tenants/:id/keys/:keyId]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ─── Global error handler ────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  // Seed tenants from AEGIS_TENANTS env var before accepting traffic.
  await seedTenantsFromEnv();

  app.listen(PORT, () => {
    console.log(`[server] Aegis API listening on port ${PORT}`);
    console.log(`[server] Dashboard → http://localhost:${PORT}/dashboard`);
  });
}

start().catch((err) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
