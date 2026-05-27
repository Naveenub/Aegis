import express from 'express';
import { getMetrics } from './engine/metrics.js';
import { getTrace, listTraces } from './engine/tracer.js';
import {
  getWorkflow,
  getRunnableSteps,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  getWorkflowStatus,
  getReviewQueue,
  resolveReview
} from './engine/workflow-store.js';
import { initVectorIndex } from './engine/vector-memory.js';
import { listJobs } from './engine/job-store.js';
import { runSystem } from './engine/orchestrator.js';
import { addStep, Priority } from './engine/queue.js';
import { assertTenantId, DEFAULT_TENANT } from './engine/tenant.js';

const app = express();
app.use(express.json());

/**
 * Resolve tenantId from request.
 * Priority: X-Tenant-ID header > body.tenantId > 'default'
 *
 * In production replace this with real auth (JWT claim, API-key lookup, etc.)
 */
function resolveTenant(req) {
  const raw = req.headers['x-tenant-id'] ?? req.body?.tenantId ?? DEFAULT_TENANT;
  return assertTenantId(raw);
}

/**
 * 🚀 Trigger task execution
 * Header: X-Tenant-ID: <tenantId>   (or body.tenantId)
 * Body: { task, priority?, timeoutMs? }
 */
app.post('/task', async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    const { task, priority = 'normal', timeoutMs } = req.body;

    const p          = Priority[priority.toUpperCase()] ?? Priority.NORMAL;
    const workflowId = await runSystem(task, { tenantId, priority: p, timeoutMs });

    res.json({ status: 'submitted', workflowId, tenantId, priority, timeoutMs: timeoutMs ?? null });
  } catch (err) {
    res.status(err.message.startsWith('Invalid tenantId') ? 400 : 500).json({ error: err.message });
  }
});

/**
 * ▶️ Resume a paused workflow
 */
app.post('/resume/:id', async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    const { id }   = req.params;

    const ok = await resumeWorkflow(id, tenantId);
    if (!ok) return res.status(409).json({ error: 'Workflow not found or not paused' });

    const steps = await getRunnableSteps(id, tenantId);
    for (const step of steps) await addStep(id, step, undefined, tenantId);

    res.json({ status: 'resumed', workflowId: id, stepsScheduled: steps.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ⏸ Pause a running workflow
 */
app.post('/pause/:id', async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    const ok       = await pauseWorkflow(req.params.id, tenantId);
    if (!ok) return res.status(409).json({ error: 'Workflow not found or not running' });
    res.json({ status: 'paused', workflowId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🛑 Cancel a workflow
 */
app.post('/cancel/:id', async (req, res) => {
  try {
    const tenantId             = resolveTenant(req);
    const { reason = 'user request' } = req.body ?? {};

    const ok = await cancelWorkflow(req.params.id, reason, tenantId);
    if (!ok) return res.status(409).json({ error: 'Workflow not found, already cancelled, or completed' });

    res.json({ status: 'cancelled', workflowId: req.params.id, reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔍 Get workflow status + steps
 */
app.get('/workflow/:id', async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    const wf       = await getWorkflow(req.params.id, tenantId);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    res.json(wf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 Metrics (global — not tenant-scoped; swap out if needed)
 */
app.get('/metrics', (req, res) => {
  try {
    res.json(getMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📁 Job State Viewer (tenant-scoped)
 */
app.get('/jobs', (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    res.json(listJobs(tenantId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 👁 Human review queue
 */
app.get('/review-queue', async (req, res) => {
  try {
    const tenantId = resolveTenant(req);
    const limit    = parseInt(req.query.limit ?? '50', 10);
    const status   = req.query.status ?? 'pending';
    const items    = await getReviewQueue({ limit, status, tenantId });
    res.json({ count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ Resolve a review item
 */
app.post('/review/:workflowId/:stepId/resolve', async (req, res) => {
  try {
    const tenantId              = resolveTenant(req);
    const { workflowId, stepId } = req.params;
    const { resolution, note = '' } = req.body ?? {};

    const validResolutions = ['resolved', 'skipped', 'retrying'];
    if (!validResolutions.includes(resolution)) {
      return res.status(400).json({ error: `Invalid resolution. Must be one of: ${validResolutions.join(', ')}` });
    }

    const record = await resolveReview(workflowId, stepId, resolution, note, tenantId);
    if (!record) return res.status(404).json({ error: 'Review item not found' });

    if (resolution === 'retrying') {
      const wf = await getWorkflow(workflowId, tenantId);
      if (wf) {
        const step = wf.steps.find(s => s.id === stepId);
        if (step) {
          await updateStep(workflowId, stepId, 'pending', tenantId);
          await addStep(workflowId, step, undefined, tenantId);
        }
      }
    }

    res.json({ status: 'ok', record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔗 Trace endpoints (global — traceId is already unique per workflow)
 */
app.get('/trace/:id', (req, res) => {
  try {
    const trace = getTrace(req.params.id);
    if (!trace) return res.status(404).json({ error: 'Trace not found' });
    res.json(trace);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/traces', (req, res) => {
  try {
    const limit = parseInt(req.query.limit ?? '50', 10);
    res.json(listTraces(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ❤️ Health Check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Init default tenant vector index on startup
await initVectorIndex(DEFAULT_TENANT);

app.listen(3000, () => {
  console.log('🚀 Aegis server running on http://localhost:3000');
  console.log('  All routes accept X-Tenant-ID header (default: "default")');
  console.log('  POST /task                          – submit task');
  console.log('  POST /pause/:id                     – pause workflow');
  console.log('  POST /resume/:id                    – resume workflow');
  console.log('  POST /cancel/:id                    – cancel workflow');
  console.log('  GET  /workflow/:id                  – workflow state + steps');
  console.log('  GET  /review-queue                  – items pending human review');
  console.log('  POST /review/:wfId/:stepId/resolve  – resolve a review item');
  console.log('  GET  /metrics                       – system metrics');
  console.log('  GET  /traces                        – list recent traces');
  console.log('  GET  /trace/:id                     – full trace for a workflow');
  console.log('  GET  /jobs                          – tenant job list');
  console.log('  GET  /health                        – health check');
});