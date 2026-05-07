import express from 'express';
import fs from 'fs';
import { getMetrics } from './engine/metrics.js';
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
import { runSystem } from './engine/orchestrator.js';
import { addStep, Priority } from './engine/queue.js';

const app = express();
app.use(express.json());

/**
 * 🚀 Trigger task execution
 * Body: { task, priority?, timeoutMs? }
 * priority: "critical" | "high" | "normal" | "low"  (default: normal)
 */
app.post('/task', async (req, res) => {
  try {
    const { task, priority = 'normal', timeoutMs } = req.body;

    const p = Priority[priority.toUpperCase()] ?? Priority.NORMAL;
    const workflowId = await runSystem(task, { priority: p, timeoutMs });

    res.json({ status: 'submitted', workflowId, priority, timeoutMs: timeoutMs ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ▶️ Resume a paused workflow
 */
app.post('/resume/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const ok = await resumeWorkflow(id);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found or not paused' });
    }

    const steps = await getRunnableSteps(id);
    for (const step of steps) {
      await addStep(id, step);
    }

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
    const { id } = req.params;

    const ok = await pauseWorkflow(id);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found or not running' });
    }

    res.json({ status: 'paused', workflowId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🛑 Cancel a workflow
 * Body: { reason? }
 */
app.post('/cancel/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = 'user request' } = req.body ?? {};

    const ok = await cancelWorkflow(id, reason);
    if (!ok) {
      return res.status(409).json({ error: 'Workflow not found, already cancelled, or completed' });
    }

    res.json({ status: 'cancelled', workflowId: id, reason });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🔍 Get workflow status + steps
 */
app.get('/workflow/:id', async (req, res) => {
  try {
    const wf = await getWorkflow(req.params.id);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    res.json(wf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📊 Metrics
 */
app.get('/metrics', (req, res) => {
  try {
    res.json(getMetrics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 📁 Job State Viewer
 */
app.get('/jobs', (req, res) => {
  try {
    const path = '.claude/context/jobs.json';
    if (!fs.existsSync(path)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(path)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * 👁 Human review queue — steps that exhausted all retries
 * Query params: ?status=pending|resolved|skipped|retrying  (default: pending)
 *               ?limit=50
 */
app.get('/review-queue', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit ?? '50', 10);
    const status = req.query.status ?? 'pending';
    const items = await getReviewQueue({ limit, status });
    res.json({ count: items.length, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * ✅ Resolve a review item
 * Body: { resolution: 'resolved' | 'skipped' | 'retrying', note?: string }
 *
 * 'retrying'  → re-queue the step (you must also POST /resume/:workflowId
 *               or the step will re-enter a paused/cancelled workflow)
 * 'skipped'   → mark the step as skipped, allow DAG to continue if possible
 * 'resolved'  → human fixed it externally, close the item
 */
app.post('/review/:workflowId/:stepId/resolve', async (req, res) => {
  try {
    const { workflowId, stepId } = req.params;
    const { resolution, note = '' } = req.body ?? {};

    const validResolutions = ['resolved', 'skipped', 'retrying'];
    if (!validResolutions.includes(resolution)) {
      return res.status(400).json({
        error: `Invalid resolution. Must be one of: ${validResolutions.join(', ')}`
      });
    }

    const record = await resolveReview(workflowId, stepId, resolution, note);
    if (!record) {
      return res.status(404).json({ error: 'Review item not found' });
    }

    // If retrying: re-queue the step so it gets another run
    if (resolution === 'retrying') {
      const wf = await getWorkflow(workflowId);
      if (wf) {
        const step = wf.steps.find(s => s.id === stepId);
        if (step) {
          // Reset step to pending so the worker processes it
          const { updateStep } = await import('./engine/workflow-store.js');
          await updateStep(workflowId, stepId, 'pending');
          await addStep(workflowId, step);
        }
      }
    }

    res.json({ status: 'ok', record });
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

await initVectorIndex();

app.listen(3000, () => {
  console.log('🚀 Aegis server running on http://localhost:3000');
  console.log('  POST /task                          – submit task');
  console.log('  POST /pause/:id                     – pause workflow');
  console.log('  POST /resume/:id                    – resume workflow');
  console.log('  POST /cancel/:id                    – cancel workflow');
  console.log('  GET  /workflow/:id                  – workflow state + steps');
  console.log('  GET  /review-queue                  – items pending human review');
  console.log('  POST /review/:wfId/:stepId/resolve  – resolve a review item');
  console.log('  GET  /metrics                       – system metrics');
  console.log('  GET  /jobs                          – job list');
  console.log('  GET  /health                        – health check');
});
