import express from 'express';
import fs from 'fs';
import { getMetrics } from './engine/metrics.js';
import {
  getWorkflow,
  getRunnableSteps,
  pauseWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  getWorkflowStatus
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
 * ❤️ Health Check
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

await initVectorIndex();

app.listen(3000, () => {
  console.log('🚀 Aegis server running on http://localhost:3000');
  console.log('  POST /task               – submit task');
  console.log('  POST /pause/:id          – pause workflow');
  console.log('  POST /resume/:id         – resume workflow');
  console.log('  POST /cancel/:id         – cancel workflow');
  console.log('  GET  /workflow/:id       – workflow state + steps');
  console.log('  GET  /metrics            – system metrics');
  console.log('  GET  /jobs               – job list');
  console.log('  GET  /health             – health check');
});
